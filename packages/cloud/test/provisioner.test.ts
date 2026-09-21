import { Clock, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { Deployments } from "../src/deployments.ts";
import { FlyApiError } from "../src/fly-board-api.ts";
import { machineConfig } from "../src/machine-spec.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { runFresh } from "./fixture.ts";
import {
	appFor,
	checkpoints,
	makeFakeProvider,
	nextClaim,
	provisionerFor,
	request,
	settings,
	volumeFor,
} from "./fixtures/provisioner.ts";

describe("Provisioner", () => {
	test("blocks unauthorized provider observations immediately", async () => {
		const provider = makeFakeProvider();
		provider.set.rejectAppRead();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT state, last_error_code FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "failed", last_error_code: "provider_rejected" },
				]);
				expect(provider.resources()).toEqual({ apps: 0, volumes: 0, machines: 0 });
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks unsupported provider response shapes immediately", async () => {
		const provider = makeFakeProvider();
		provider.set.decodeAppRead();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT state, last_error_code FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "failed", last_error_code: "provider_drift" },
				]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks unsupported edge responses without consuming the transient failure budget", async () => {
		const provider = makeFakeProvider();
		provider.fake.listIpAssignments = () =>
			Effect.fail(new FlyApiError({ operation: "list_ips", reason: "decode", status: 200 }));
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT state, failure_count, last_error_code FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([{ state: "failed", failure_count: 0, last_error_code: "provider_drift" }]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("keeps app-scoped 404s and repairable DNS conflicts on the waiting budget", async () => {
		for (const condition of ["not-found", "cname"] as const) {
			const provider = makeFakeProvider();
			if (condition === "not-found")
				provider.fake.allocateSharedIp = () =>
					Effect.fail(new FlyApiError({ operation: "allocate_ip", reason: "status", status: 404 }));
			else
				provider.networking.state.records.push({
					id: "delegated",
					name: "boards.chirp.wiki",
					type: "CNAME",
					content: "other.example",
				});
			await runFresh(
				Effect.gen(function* () {
					yield* migrateCloudDatabase;
					yield* (yield* Boards).request({ ...request, idempotency_key: condition });
					const first = yield* nextClaim("worker-1");
					expect(yield* (yield* Provisioner).run(first, "worker-1")).toBe("requeued");
					const second = yield* nextClaim("worker-2");
					expect(yield* (yield* Provisioner).run(second, "worker-2")).toBe("requeued");
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT failure_count, last_error_code FROM board_operations WHERE id = ${first.id}`,
					).toEqual([{ failure_count: 0, last_error_code: "provider_observation_pending" }]);
				}).pipe(Effect.provide(provisionerFor(provider))),
			);
		}
	});

	test("bounds healthy waiting by the configurable operation lifetime before provider work", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_operations SET created_at = clock_timestamp() - interval '1 hour'`;
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				expect(provider.resources()).toEqual({ apps: 0, volumes: 0, machines: 0 });
				expect(yield* sql`SELECT failure_count, last_error_code FROM board_operations`).toEqual([
					{ failure_count: 0, last_error_code: "retry_exhausted" },
				]);
			}).pipe(Effect.provide(provisionerFor(provider, { ...settings, maxOperationAgeMs: 1_000 }))),
		);
	});

	test("stops new provider work after an in-flight call crosses the operation lifetime", async () => {
		const provider = makeFakeProvider();
		provider.set.delayCreateApp(500);
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				expect(provider.resources()).toEqual({ apps: 1, volumes: 0, machines: 0 });
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT checkpoint, failure_count, ambiguous_mutations, last_error_code
						FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([
					{
						checkpoint: "storage_configuration_verified",
						failure_count: 0,
						ambiguous_mutations: ["app_create"],
						last_error_code: "retry_exhausted",
					},
				]);
			}).pipe(Effect.provide(provisionerFor(provider, { ...settings, maxOperationAgeMs: 400 }))),
		);
	});

	test("rechecks the operation lifetime after persisting a mutation marker", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operations = yield* Operations;
				const delayedOperations = {
					...operations,
					markAmbiguousMutation: (input: Parameters<typeof operations.markAmbiguousMutation>[0]) =>
						operations.markAmbiguousMutation(input).pipe(Effect.tap(() => Effect.sleep(1_100))),
				};
				const provisioner = yield* Provisioner.pipe(
					Effect.provide(
						provisionerFor(provider, { ...settings, maxOperationAgeMs: 1_000 }).pipe(
							Layer.provide(Layer.succeed(Operations, delayedOperations)),
						),
					),
				);
				const operation = yield* nextClaim("worker");
				expect(yield* provisioner.run(operation, "worker")).toBe("blocked");
				expect(provider.resources()).toEqual({ apps: 0, volumes: 0, machines: 0 });
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT checkpoint, failure_count, ambiguous_mutations, last_error_code
						FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([
					{
						checkpoint: "storage_configuration_verified",
						failure_count: 0,
						ambiguous_mutations: ["app_create"],
						last_error_code: "retry_exhausted",
					},
				]);
			}),
		);
	});

	test("does not finalize after the last provider validation crosses the lifetime", async () => {
		const provider = makeFakeProvider();
		provider.networking.state.checkCertificateDelayAt = 3;
		provider.networking.state.checkCertificateDelayMs = 1_100;
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				expect(provider.resources()).toEqual({ apps: 1, volumes: 1, machines: 1 });
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT checkpoint, failure_count, last_error_code FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([{ checkpoint: "child_route_observed", failure_count: 0, last_error_code: "retry_exhausted" }]);
			}).pipe(Effect.provide(provisionerFor(provider, { ...settings, maxOperationAgeMs: 1_000 }))),
		);
	});

	test("never schedules an ambiguity poll after its operation deadline", async () => {
		const provider = makeFakeProvider();
		provider.set.hideAppAfterCreate();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = yield* nextClaim("worker");
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("requeued");
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT available_at <= created_at + interval '30 seconds' AS bounded
						FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([{ bounded: true }]);
			}).pipe(
				Effect.provide(provisionerFor(provider, { ...settings, maxOperationAgeMs: 30_000, pollIntervalMs: 10_000 })),
			),
		);
	});

	test.each(["app", "volume", "machine"] as const)(
		"never repeats an unobserved %s create automatically",
		async (resource) => {
			const provider = makeFakeProvider();
			if (resource === "app") provider.set.failCreateAppBeforeMutation();
			else if (resource === "volume") provider.set.failCreateVolumeBeforeMutation();
			else provider.set.failCreateMachineBeforeMutation();
			await runFresh(
				Effect.gen(function* () {
					yield* migrateCloudDatabase;
					yield* (yield* Boards).request(request);
					const provisioner = yield* Provisioner;
					const first = yield* nextClaim("worker-1");
					expect(yield* provisioner.run(first, "worker-1")).toBe("requeued");
					const second = yield* nextClaim("worker-2");
					expect(yield* provisioner.run(second, "worker-2")).toBe("requeued");
					expect(
						provider.calls[resource === "app" ? "createApp" : resource === "volume" ? "createVolume" : "createMachine"],
					).toBe(1);
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT last_error_code FROM board_operations WHERE id = ${first.id}`).toEqual([
						{ last_error_code: `${resource}_create_ambiguous` },
					]);
				}).pipe(Effect.provide(provisionerFor(provider))),
			);
		},
	);

	test("retains an ambiguity marker across an intervening observation failure", async () => {
		const provider = makeFakeProvider();
		provider.set.failCreateVolumeBeforeMutation();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const first = yield* nextClaim("worker-1");
				expect(yield* provisioner.run(first, "worker-1")).toBe("requeued");
				provider.set.failListVolumes();
				const second = yield* nextClaim("worker-2");
				expect(yield* provisioner.run(second, "worker-2")).toBe("requeued");
				const third = yield* nextClaim("worker-3");
				expect(yield* provisioner.run(third, "worker-3")).toBe("requeued");
				expect(provider.calls.createVolume).toBe(1);
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT last_error_code FROM board_operations WHERE id = ${first.id}`).toEqual([
					{ last_error_code: "volume_create_ambiguous" },
				]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("persists a Volume marker before the call and survives a failed readback", async () => {
		const provider = makeFakeProvider();
		provider.set.failCreateVolumeAndReadback();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const first = yield* nextClaim("worker-1");
				expect(yield* provisioner.run(first, "worker-1")).toBe("requeued");
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT ambiguous_mutations, last_error_code FROM board_operations WHERE id = ${first.id}`,
				).toEqual([{ ambiguous_mutations: ["volume_create"], last_error_code: "provider_unavailable" }]);
				provider.set.hideVolumes();
				const second = yield* nextClaim("worker-2");
				expect(yield* provisioner.run(second, "worker-2")).toBe("requeued");
				expect(provider.calls.createVolume).toBe(1);
				expect(provider.resources().volumes).toBe(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("persists a Volume marker across a worker crash after provider acceptance", async () => {
		const provider = makeFakeProvider();
		provider.set.hideVolumes();
		const createVolume = provider.fake.createVolume;
		provider.fake.createVolume = (input) =>
			createVolume(input).pipe(Effect.andThen(Effect.die("simulated worker interruption")));
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const first = yield* nextClaim("worker-1");
				expect(Exit.isFailure(yield* Effect.exit((yield* Provisioner).run(first, "worker-1")))).toBe(true);
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT ambiguous_mutations FROM board_operations WHERE id = ${first.id}`).toEqual([
					{ ambiguous_mutations: ["volume_create"] },
				]);
				yield* sql`UPDATE board_operations SET lease_expires_at = clock_timestamp() - interval '1 second'
					WHERE id = ${first.id}`;
				const second = Option.getOrThrow(yield* (yield* Operations).claim("worker-2", 30_000));
				expect(yield* (yield* Provisioner).run(second, "worker-2")).toBe("requeued");
				expect(provider.calls.createVolume).toBe(1);
				expect(provider.resources().volumes).toBe(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("keeps unresolved edge and Machine-start mutations independently", async () => {
		const provider = makeFakeProvider();
		provider.set.failHealth();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const first = yield* nextClaim("worker-1");
				expect(yield* provisioner.run(first, "worker-1")).toBe("requeued");
				const second = yield* nextClaim("worker-2");
				if (!second.lease_token) return yield* Effect.die("Claim returned no lease token");
				const operations = yield* Operations;
				yield* operations.markAmbiguousMutation({
					id: second.id,
					leaseToken: second.lease_token,
					workerId: "worker-2",
					mutation: "edge_a_record",
				});
				yield* operations.requeue({
					id: second.id,
					leaseToken: second.lease_token,
					workerId: "worker-2",
					availableAt: new Date(yield* Clock.currentTimeMillis),
					errorCode: "provider_unavailable",
					errorMessage: "intervening observation failed",
				});
				provider.set.stopMachines();
				provider.set.failStartMachineBeforeMutation();
				const third = yield* nextClaim("worker-3");
				expect(yield* provisioner.run(third, "worker-3")).toBe("requeued");
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT ambiguous_mutations FROM board_operations WHERE id = ${first.id}`).toEqual([
					{ ambiguous_mutations: ["edge_a_record", "machine_start"] },
				]);
				expect(provider.calls.startMachine).toBe(2);
				const fourth = yield* nextClaim("worker-4");
				expect(yield* provisioner.run(fourth, "worker-4")).toBe("requeued");
				expect(provider.calls.startMachine).toBe(2);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks an untracked service-bearing Machine without creating another", async () => {
		const provider = makeFakeProvider();
		provider.set.failCreateMachineBeforeMutation();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const first = yield* nextClaim("worker-1");
				expect(yield* provisioner.run(first, "worker-1")).toBe("requeued");
				const deployment = Option.getOrThrow(yield* (yield* Deployments).get(board.id));
				provider.set.machine({
					id: "foreign-machine",
					name: "foreign-machine",
					state: "started",
					region: deployment.region,
					instance_id: "foreign-version",
					config: {
						...machineConfig(deployment),
						metadata: { "chirp.deployment_id": "foreign", "chirp.controller_schema": "1" },
					},
					checks: [{ status: "passing" }],
				});
				const second = yield* nextClaim("worker-2");
				expect(yield* provisioner.run(second, "worker-2")).toBe("blocked");
				expect(provider.calls.createMachine).toBe(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("bounds persistent failures independently from claim attempts and releases the board slot", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operations = yield* Operations;
				const sql = yield* SqlClient.SqlClient;
				const provisioner = yield* Provisioner;
				for (let attempt = 1; attempt <= 10; attempt += 1) {
					provider.set.failHealth();
					const operation = yield* nextClaim("worker-1");
					const before = yield* Clock.currentTimeMillis;
					expect(yield* provisioner.run(operation, "worker-1")).toBe(attempt === 10 ? "blocked" : "requeued");
					if (attempt < 10) {
						const rows = yield* sql<{
							available_at: string;
						}>`SELECT available_at::text FROM board_operations WHERE id = ${operation.id}`;
						const ceiling = Math.min(300_000, 5_000 * 2 ** (attempt - 1));
						const scheduled = Date.parse(rows[0]!.available_at);
						expect(scheduled).toBeGreaterThanOrEqual(before + ceiling / 2);
						expect(scheduled).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) + ceiling);
						expect(Option.isNone(yield* operations.claim("too-early", 30_000))).toBe(true);
					}
				}
				expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id)).state).toBe("blocked");
				expect(
					yield* sql`SELECT state, attempt, failure_count, lease_token, last_error_code
						FROM board_operations WHERE board_id = ${board.id}`,
				).toEqual([
					{ state: "failed", attempt: 10, failure_count: 10, lease_token: null, last_error_code: "retry_exhausted" },
				]);
				expect(Option.isNone(yield* operations.claim("worker-2", 30_000))).toBe(true);
				expect(provider.resources()).toEqual({ apps: 1, volumes: 1, machines: 1 });
				expect(
					(yield* operations.enqueue({
						board_id: board.id,
						owner_id: board.owner_id,
						kind: "backup",
						requested_by: "operator",
						idempotency_key: "after-exhaustion",
					})).state,
				).toBe("queued");
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test.each([9, 10])(
		"finishes a durably provisioned deployment after a finalization crash on attempt %i",
		async (attempt) => {
			const provider = makeFakeProvider();
			await runFresh(
				Effect.gen(function* () {
					yield* migrateCloudDatabase;
					const board = yield* (yield* Boards).request(request);
					const operation = yield* nextClaim("worker-1");
					expect(yield* (yield* Provisioner).run(operation, "worker-1")).toBe("succeeded");
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE board_operations SET state = 'running', attempt = ${attempt}, finished_at = NULL,
				lease_token = ${operation.lease_token}, lease_owner = 'worker-1',
				lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${operation.id}`;
					provider.set.rejectAppRead();
					const recovered = yield* nextClaim("worker-2");
					expect(yield* (yield* Provisioner).run(recovered, "worker-2")).toBe("succeeded");
					expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id)).state).toBe("provisioned");
					expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
				}).pipe(Effect.provide(provisionerFor(provider))),
			);
		},
	);

	test("does not spend the provider failure budget on crash-reclaimed claims", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_operations SET attempt = 100`;
				const operation = yield* nextClaim("worker-1");
				expect(yield* (yield* Provisioner).run(operation, "worker-1")).toBe("succeeded");
				expect(provider.resources()).toEqual({ apps: 1, volumes: 1, machines: 1 });
				expect(yield* sql`SELECT attempt, failure_count FROM board_operations`).toEqual([
					{ attempt: 101, failure_count: 0 },
				]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("provisions one app, volume, and machine and completes the operation", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				const outcome = yield* (yield* Provisioner).run(operation, "worker-1");
				const sql = yield* SqlClient.SqlClient;
				const deployments = yield* Deployments;
				const deployment = Option.getOrThrow(yield* deployments.get(board.id));
				expect(outcome).toBe("succeeded");
				expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
				expect(yield* sql`SELECT state, checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "succeeded", checkpoint: "provisioned" },
				]);
				expect(deployment.state).toBe("provisioned");
				expect(yield* sql`SELECT hostname, board_id, app_name FROM board_routes`).toHaveLength(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("waits for certificate readiness before publishing a route or probing the edge", async () => {
		const provider = makeFakeProvider();
		provider.networking.state.ready = false;
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const sql = yield* SqlClient.SqlClient;
				let operation = yield* nextClaim("worker-1");
				for (let poll = 0; poll < 12; poll += 1) {
					expect(yield* provisioner.run(operation, `worker-${poll + 1}`)).toBe("requeued");
					expect(yield* sql`SELECT failure_count FROM board_operations WHERE id = ${operation.id}`).toEqual([
						{ failure_count: 0 },
					]);
					operation = yield* nextClaim(`worker-${poll + 2}`);
				}
				expect(yield* sql`SELECT * FROM board_routes`).toEqual([]);
				provider.networking.state.ready = true;
				expect(yield* provisioner.run(operation, "worker-13")).toBe("succeeded");
				expect(yield* sql`SELECT hostname FROM board_routes`).toHaveLength(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test.each(checkpoints)("resumes from the %s checkpoint without duplicating resources", async (checkpoint) => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const lease = { operationId: operation.id, leaseToken: operation.lease_token, workerId: "worker-1" };
				const deployments = yield* Deployments;
				let deployment = yield* deployments.ensure({
					...lease,
					spec: {
						hostname: `${board.slug}.${settings.boardsDomain}`,
						region: settings.region,
						image_ref: settings.imageRef,
						app_name: `chirp-${board.slug}`,
						network_name: `chirp-${board.slug}`,
						volume_name: `chirp_data_${board.slug}`,
						machine_name: `board-${board.slug}`,
						volume_size_gb: settings.volumeSizeGb,
					},
				});
				for (const next of checkpoints.slice(1, checkpoints.indexOf(checkpoint) + 1)) {
					if (next === "edge_reachable")
						yield* deployments.publishRoute({ ...lease, expectedRowVersion: deployment.row_version });
					deployment = yield* deployments.transition({
						...lease,
						expectedCheckpoint: deployment.state,
						expectedRowVersion: deployment.row_version,
						next,
						...(next === "app_created" ? { appId: "app-id" } : {}),
						...(next === "volume_created" ? { volumeId: "volume-id" } : {}),
						...(next === "machine_created" ? { machineId: "machine-id" } : {}),
					});
				}
				const checkpointIndex = checkpoints.indexOf(checkpoint);
				if (checkpointIndex >= checkpoints.indexOf("app_created")) provider.set.app(appFor(board.slug));
				if (checkpointIndex >= checkpoints.indexOf("volume_created")) provider.set.volume(volumeFor(board.slug));
				if (checkpointIndex >= checkpoints.indexOf("machine_created"))
					provider.set.machine({
						id: "machine-id",
						name: deployment.machine_name,
						state: checkpoint === "machine_created" ? "stopped" : "started",
						region: deployment.region,
						instance_id: "machine-version-1",
						config: machineConfig(deployment),
						checks: checkpoint === "machine_created" ? [] : [{ status: "passing" }],
					});
				const outcome = yield* (yield* Provisioner).run(operation, "worker-1");
				expect(outcome).toBe("succeeded");
				expect(provider.resources()).toEqual({ apps: 1, volumes: 1, machines: 1 });
				expect(Option.getOrThrow(yield* deployments.get(board.id)).state).toBe("provisioned");
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("replays provider observation failures without creating duplicate resources", async () => {
		const provider = makeFakeProvider();
		provider.set.hideAppAfterCreate();
		provider.set.failListVolumes();
		provider.set.failGetVolume();
		provider.set.failListMachines();
		provider.set.failGetMachine();
		provider.set.failHealth();
		provider.set.failChildRoute();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				const first = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				const expectedCheckpoints = [
					"storage_configuration_verified",
					"app_created",
					"volume_created",
					"volume_created",
					"machine_created",
					"machine_started",
					"edge_reachable",
				] as const;
				let operation = first;
				for (const [index, checkpoint] of expectedCheckpoints.entries()) {
					const outcome = yield* provisioner.run(operation, `worker-${index + 1}`);
					expect(outcome).toBe("requeued");
					const sql = yield* SqlClient.SqlClient;
					expect(yield* sql`SELECT checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
						{ checkpoint },
					]);
					operation = yield* nextClaim(`worker-${index + 2}`);
				}
				const outcome = yield* provisioner.run(operation, "worker-8");
				const sql = yield* SqlClient.SqlClient;
				const deployments = yield* Deployments;
				const deployment = Option.getOrThrow(yield* deployments.get(board.id));
				expect(outcome).toBe("succeeded");
				expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
				expect(yield* sql`SELECT state, checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "succeeded", checkpoint: "provisioned" },
				]);
				expect(deployment.state).toBe("provisioned");
				expect(yield* sql`SELECT COUNT(*)::int AS count FROM board_routes`).toEqual([{ count: 1 }]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("adopts exactly one resource after ambiguous app, volume, and machine mutations", async () => {
		const provider = makeFakeProvider();
		provider.set.failCreateApp();
		provider.set.failCreateVolume();
		provider.set.failCreateMachine();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				const outcome = yield* (yield* Provisioner).run(operation, "worker-1");
				const sql = yield* SqlClient.SqlClient;
				expect(outcome).toBe("succeeded");
				expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
				expect(yield* sql`SELECT COUNT(*)::int AS count FROM board_deployments WHERE board_id = ${board.id}`).toEqual([
					{ count: 1 },
				]);
				expect(yield* sql`SELECT state FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "succeeded" },
				]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks a definite provider rejection instead of retrying it forever", async () => {
		const provider = makeFakeProvider();
		provider.set.rejectCreateAppAndReadback();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				expect(yield* (yield* Provisioner).run(operation, "worker-1")).toBe("blocked");
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* sql`SELECT state, failure_count, ambiguous_mutations, last_error_code
						FROM board_operations WHERE id = ${operation.id}`,
				).toEqual([
					{ state: "failed", failure_count: 0, ambiguous_mutations: [], last_error_code: "provider_rejected" },
				]);
				expect(provider.calls.createApp).toBe(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks provider duplicates before issuing further mutations", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				provider.set.app(appFor(board.slug));
				provider.set.addDuplicateVolume(board.slug);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				const outcome = yield* (yield* Provisioner).run(operation, "worker-1");
				const sql = yield* SqlClient.SqlClient;
				const deployments = yield* Deployments;
				const deployment = Option.getOrThrow(yield* deployments.get(board.id));
				expect(outcome).toBe("blocked");
				expect(provider.calls).toMatchObject({ createApp: 0, createVolume: 0, createMachine: 0 });
				expect(yield* sql`SELECT state, last_error_code FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "failed", last_error_code: "provider_drift" },
				]);
				expect(deployment.state).toBe("blocked");
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("blocks a replacement App that reused the reserved name", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const lease = { operationId: operation.id, leaseToken: operation.lease_token, workerId: "worker-1" };
				const deployments = yield* Deployments;
				let deployment = yield* deployments.ensure({
					...lease,
					spec: {
						hostname: `${board.slug}.${settings.boardsDomain}`,
						region: settings.region,
						image_ref: settings.imageRef,
						app_name: `chirp-${board.slug}`,
						network_name: `chirp-${board.slug}`,
						volume_name: `chirp_data_${board.slug}`,
						machine_name: `board-${board.slug}`,
						volume_size_gb: settings.volumeSizeGb,
					},
				});
				deployment = yield* deployments.transition({
					...lease,
					expectedCheckpoint: deployment.state,
					expectedRowVersion: deployment.row_version,
					next: "storage_configuration_verified",
				});
				yield* deployments.transition({
					...lease,
					expectedCheckpoint: deployment.state,
					expectedRowVersion: deployment.row_version,
					next: "app_created",
					appId: "original-app-id",
				});
				provider.set.app({ ...appFor(board.slug), id: "replacement-app-id" });
				expect(yield* (yield* Provisioner).run(operation, "worker-1")).toBe("blocked");
				expect(provider.calls).toMatchObject({ createVolume: 0, createMachine: 0 });
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("fences a stale lease before it can mutate Fly", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operations = yield* Operations;
				const stale = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_operations SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${stale.id}`;
				yield* operations.claim("worker-2", 30_000);
				expect(yield* (yield* Provisioner).run(stale, "worker-1")).toBe("lost_lease");
				expect(provider.calls).toMatchObject({ createApp: 0, createVolume: 0, createMachine: 0 });
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("requeues health and child-route failures instead of completing", async () => {
		const provider = makeFakeProvider();
		provider.set.failHealth();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const provisioner = yield* Provisioner;
				let operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				let outcome = yield* provisioner.run(operation, "worker-1");
				const sql = yield* SqlClient.SqlClient;
				expect(outcome).toBe("requeued");
				expect(yield* sql`SELECT state, checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "queued", checkpoint: "machine_started" },
				]);
				provider.set.failChildRoute();
				operation = yield* nextClaim("worker-2");
				outcome = yield* provisioner.run(operation, "worker-2");
				expect(outcome).toBe("requeued");
				expect(yield* sql`SELECT state, checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "queued", checkpoint: "edge_reachable" },
				]);
				expect(yield* sql`SELECT COUNT(*)::int AS count FROM board_routes`).toEqual([{ count: 1 }]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});
});
