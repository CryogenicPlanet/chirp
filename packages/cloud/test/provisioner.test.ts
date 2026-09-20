import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import type { DeploymentState } from "../src/deployment.ts";
import { EdgeProbe, EdgeProbeError } from "../src/edge-probe.ts";
import { FlyApiError, FlyBoardApi } from "../src/fly-board-api.ts";
import type { FlyApp, FlyMachine, FlyVolume } from "../src/fly-model.ts";
import { machineConfig } from "../src/machine-spec.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner, provisionerLayer } from "../src/provisioner.ts";
import { Deployments } from "../src/deployments.ts";
import type { ProvisioningSettings } from "../src/provisioning-settings.ts";
import { runFresh } from "./fixture.ts";

const settings: ProvisioningSettings = {
	organization: "chirp",
	region: "sjc",
	imageRef: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	boardsDomain: "boards.chirp.wiki",
	volumeSizeGb: 1,
};

const request = {
	owner_id: "user-1",
	name: "Managed board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-fly-1",
} as const;
const checkpoints: ReadonlyArray<Exclude<DeploymentState, "blocked">> = [
	"requested",
	"storage_configuration_verified",
	"app_created",
	"volume_created",
	"runtime_secrets_written",
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
];

const appFor = (slug: string): FlyApp => ({
	id: "app-id",
	name: `chirp-${slug}`,
	network: `chirp-${slug}`,
	organization: { slug: settings.organization },
});

const volumeFor = (slug: string): FlyVolume => ({
	id: "volume-id",
	name: `chirp_data_${slug}`,
	state: "created",
	region: settings.region,
	encrypted: true,
	size_gb: settings.volumeSizeGb,
	auto_backup_enabled: true,
	fstype: "ext4",
});

const flyUnavailable = (operation: string) => new FlyApiError({ operation, reason: "transport", status: null });

const makeFakeProvider = () => {
	let app: FlyApp | undefined;
	const volumes: FlyVolume[] = [];
	const machines: FlyMachine[] = [];
	let hideAppReads = 0;
	let failListVolumes = false;
	let failGetVolume = false;
	let failListMachines = false;
	let failGetMachine = false;
	let failCreateApp = false;
	let rejectCreateApp = false;
	let failCreateVolume = false;
	let failCreateMachine = false;
	let failHealth = false;
	let failChildRoute = false;
	const calls = {
		createApp: 0,
		createVolume: 0,
		createMachine: 0,
		listSecrets: 0,
		updateSecrets: 0,
	};
	const fake = {
		getApp: (name: string) =>
			Effect.sync(() => {
				if (app?.name !== name) return Option.none<FlyApp>();
				if (hideAppReads > 0) {
					hideAppReads -= 1;
					return Option.none<FlyApp>();
				}
				return Option.some(app);
			}),
		createApp: (input: { readonly name: string; readonly organization: string; readonly network: string }) =>
			Effect.gen(function* () {
				calls.createApp += 1;
				if (rejectCreateApp) {
					rejectCreateApp = false;
					return yield* new FlyApiError({ operation: "create_app", reason: "status", status: 400 });
				}
				app = { id: "app-id", name: input.name, network: input.network, organization: { slug: input.organization } };
				if (failCreateApp) {
					failCreateApp = false;
					return yield* Effect.fail(flyUnavailable("create_app"));
				}
			}).pipe(Effect.asVoid),
		listVolumes: (_name: string) =>
			Effect.gen(function* () {
				if (failListVolumes) {
					failListVolumes = false;
					return yield* Effect.fail(flyUnavailable("list_volumes"));
				}
				return volumes;
			}),
		getVolume: (_name: string, id: string) =>
			Effect.gen(function* () {
				if (failGetVolume) {
					failGetVolume = false;
					return yield* Effect.fail(flyUnavailable("get_volume"));
				}
				return Option.fromNullishOr(volumes.find((volume) => volume.id === id));
			}),
		createVolume: (input: {
			readonly appName: string;
			readonly name: string;
			readonly region: string;
			readonly sizeGb: number;
		}) =>
			Effect.gen(function* () {
				calls.createVolume += 1;
				const volume = { ...volumeFor(input.name.replace(/^chirp_data_/, "")), name: input.name };
				volumes.push(volume);
				if (failCreateVolume) {
					failCreateVolume = false;
					return yield* Effect.fail(flyUnavailable("create_volume"));
				}
				return volume;
			}),
		listSecrets: (_name: string) =>
			Effect.sync(() => {
				calls.listSecrets += 1;
				return [];
			}),
		updateSecrets: (_name: string, _values: Readonly<Record<string, string>>) =>
			Effect.sync(() => {
				calls.updateSecrets += 1;
				return 1;
			}),
		listMachines: (_name: string) =>
			Effect.gen(function* () {
				if (failListMachines) {
					failListMachines = false;
					return yield* Effect.fail(flyUnavailable("list_machines"));
				}
				return machines;
			}),
		getMachine: (_name: string, id: string) =>
			Effect.gen(function* () {
				if (failGetMachine) {
					failGetMachine = false;
					return yield* Effect.fail(flyUnavailable("get_machine"));
				}
				return Option.fromNullishOr(machines.find((machine) => machine.id === id));
			}),
		createMachine: (input: {
			readonly appName: string;
			readonly name: string;
			readonly region: string;
			readonly config: FlyMachine["config"];
			readonly minSecretsVersion?: number;
		}) =>
			Effect.gen(function* () {
				calls.createMachine += 1;
				const machine: FlyMachine = {
					id: "machine-id",
					name: input.name,
					state: "stopped",
					region: input.region,
					instance_id: "machine-version-1",
					config: input.config,
					checks: [{ status: "passing" }],
				};
				const volumeIndex = volumes.findIndex((volume) => volume.id === input.config.mounts[0]?.volume);
				if (volumeIndex >= 0) volumes[volumeIndex] = { ...volumes[volumeIndex]!, attached_machine_id: machine.id };
				machines.push(machine);
				if (failCreateMachine) {
					failCreateMachine = false;
					return yield* Effect.fail(flyUnavailable("create_machine"));
				}
				return machine;
			}),
		updateMachine: () => Effect.die("unexpected machine update"),
		startMachine: (_name: string, id: string) =>
			Effect.sync(() => {
				const index = machines.findIndex((machine) => machine.id === id);
				if (index >= 0) machines[index] = { ...machines[index]!, state: "started", checks: [{ status: "passing" }] };
			}),
		stopMachine: () => Effect.die("unexpected machine stop"),
		waitMachine: (_name: string, _id: string, state: "started" | "stopped", version: string) =>
			Effect.succeed({ ok: true, state, version }),
		listVolumeSnapshots: () => Effect.succeed([]),
	};
	const edge = {
		health: (_hostname: string) =>
			Effect.gen(function* () {
				if (failHealth) {
					failHealth = false;
					return yield* Effect.fail(new EdgeProbeError({ path: "/health", reason: "network" }));
				}
			}).pipe(Effect.asVoid),
		childRoute: (_hostname: string) =>
			Effect.gen(function* () {
				if (failChildRoute) {
					failChildRoute = false;
					return yield* Effect.fail(new EdgeProbeError({ path: "/init", reason: "network" }));
				}
			}).pipe(Effect.asVoid),
	};
	return {
		fake,
		edge,
		calls,
		set: {
			app: (value: FlyApp | undefined) => {
				app = value;
			},
			hideAppAfterCreate: () => {
				hideAppReads = 1;
			},
			failListVolumes: () => {
				failListVolumes = true;
			},
			failGetVolume: () => {
				failGetVolume = true;
			},
			failListMachines: () => {
				failListMachines = true;
			},
			failGetMachine: () => {
				failGetMachine = true;
			},
			failCreateApp: () => {
				failCreateApp = true;
			},
			rejectCreateApp: () => {
				rejectCreateApp = true;
			},
			failCreateVolume: () => {
				failCreateVolume = true;
			},
			failCreateMachine: () => {
				failCreateMachine = true;
			},
			failHealth: () => {
				failHealth = true;
			},
			failChildRoute: () => {
				failChildRoute = true;
			},
			addDuplicateVolume: (slug: string) => {
				volumes.push(volumeFor(slug));
				volumes.push({ ...volumeFor(slug), id: "duplicate-volume-id" });
			},
			volume: (value: FlyVolume) => {
				volumes.push(value);
			},
			machine: (value: FlyMachine) => {
				const volumeIndex = volumes.findIndex((volume) => volume.id === value.config.mounts[0]?.volume);
				if (volumeIndex >= 0) volumes[volumeIndex] = { ...volumes[volumeIndex]!, attached_machine_id: value.id };
				machines.push(value);
			},
		},
		resources: () => ({ apps: app ? 1 : 0, volumes: volumes.length, machines: machines.length }),
	};
};

const providerLayer = (provider: ReturnType<typeof makeFakeProvider>) =>
	Layer.mergeAll(Layer.succeed(FlyBoardApi, provider.fake), Layer.succeed(EdgeProbe, provider.edge));

const provisionerFor = (provider: ReturnType<typeof makeFakeProvider>) =>
	provisionerLayer(settings).pipe(Layer.provide(providerLayer(provider)));

const nextClaim = (workerId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE board_operations SET available_at = clock_timestamp()`;
		return Option.getOrThrow(yield* (yield* Operations).claim(workerId, 30_000));
	});

describe("Provisioner", () => {
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
				expect(provider.calls).toMatchObject({ listSecrets: 0, updateSecrets: 0 });
				expect(yield* sql`SELECT state, checkpoint FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "succeeded", checkpoint: "provisioned" },
				]);
				expect(deployment.state).toBe("provisioned");
				expect(yield* sql`SELECT hostname, board_id, app_name FROM board_routes`).toHaveLength(1);
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
						...(next === "machine_created" ? { machineId: "machine-id", machineVersion: "machine-version-1" } : {}),
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
					"runtime_secrets_written",
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
		provider.set.rejectCreateApp();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				expect(yield* (yield* Provisioner).run(operation, "worker-1")).toBe("blocked");
				const sql = yield* SqlClient.SqlClient;
				expect(yield* sql`SELECT state, last_error_code FROM board_operations WHERE id = ${operation.id}`).toEqual([
					{ state: "failed", last_error_code: "provider_rejected" },
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
				const result = yield* Effect.exit((yield* Provisioner).run(stale, "worker-1"));
				expect(result._tag).toBe("Failure");
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
