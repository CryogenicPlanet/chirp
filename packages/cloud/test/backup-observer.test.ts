import { eq } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { describe, expect, test } from "vitest";
import { BackupObserver, backupObserverLayer } from "../src/backup-observer.ts";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { Deployments } from "../src/deployments.ts";
import { FlyBoardApi } from "../src/fly-board-api.ts";
import type { FlyVolumeSnapshot } from "../src/fly-model.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { boardOperations } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";

const request = {
	owner_id: "user-1",
	name: "Managed board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-backup-test",
} as const;

const spec = {
	hostname: "0123456789abcdef0123456789abcdef.boards.chirp.wiki",
	region: "sjc",
	image_ref: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	app_name: "chirp-0123456789abcdef0123456789abcdef",
	network_name: "chirp-0123456789abcdef0123456789abcdef",
	volume_name: "chirp_data_0123456789abcdef0123456789abcdef",
	machine_name: "board-0123456789abcdef0123456789abcdef",
	volume_size_gb: 1,
} as const;

const impossible = () => Effect.die("Unexpected Fly API call");
const flyLayer = (snapshots: ReadonlyArray<FlyVolumeSnapshot>, observed?: { calls: number }) =>
	Layer.succeed(FlyBoardApi, {
		listIpAssignments: impossible,
		allocateSharedIp: impossible,
		getCertificate: impossible,
		createCertificate: impossible,
		checkCertificate: impossible,
		getApp: impossible,
		createApp: impossible,
		listVolumes: impossible,
		getVolume: impossible,
		createVolume: impossible,
		listMachines: impossible,
		getMachine: impossible,
		createMachine: impossible,
		startMachine: impossible,
		waitMachine: impossible,
		listVolumeSnapshots: () =>
			Effect.sync(() => {
				if (observed) observed.calls += 1;
				return snapshots;
			}),
	});

const prepare = Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const board = yield* (yield* Boards).request(request);
	const operations = yield* Operations;
	const provision = Option.getOrThrow(yield* operations.claim("provisioner", 30_000, "provision"));
	if (!provision.lease_token) return yield* Effect.die("Provision claim returned no lease token");
	const lease = { operationId: provision.id, leaseToken: provision.lease_token, workerId: "provisioner" };
	const deployments = yield* Deployments;
	let deployment = yield* deployments.ensure({ ...lease, spec });
	for (const next of [
		"storage_configuration_verified",
		"app_created",
		"volume_created",
		"machine_created",
		"machine_started",
		"edge_reachable",
		"child_route_observed",
		"provisioned",
	] as const) {
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
	yield* operations.succeed(provision.id, lease.leaseToken, lease.workerId);
	const queued = yield* operations.enqueue({
		board_id: board.id,
		owner_id: board.owner_id,
		kind: "backup",
		requested_by: board.owner_id,
		idempotency_key: "observe-backup-1",
	});
	const backup = Option.getOrThrow(yield* operations.claim("backup-observer", 30_000, "backup"));
	expect(backup.id).toBe(queued.id);
	return { backup, board, deployment };
});

const runObserver = <A, E>(snapshots: ReadonlyArray<FlyVolumeSnapshot>, effect: Effect.Effect<A, E, BackupObserver>) =>
	effect.pipe(Effect.provide(backupObserverLayer.pipe(Layer.provide(flyLayer(snapshots)))));

describe("BackupObserver", () => {
	test("records only the newest explicitly completed snapshot and finishes the leased operation", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { backup, board } = yield* prepare;
				const outcome = yield* runObserver(
					[
						{ id: "pending", status: "pending", created_at: "2026-09-20T12:00:00.000Z" },
						{
							id: "missing-status",
							created_at: "2026-09-20T11:00:00.000Z",
							digest: "sha256:missing-status",
							retention_days: 5,
						},
						{
							id: "null-status",
							status: null,
							created_at: "2026-09-20T10:00:00.000Z",
							digest: "sha256:null-status",
							retention_days: 4,
						},
						{
							id: "newest",
							status: "created",
							created_at: "2026-09-19T11:00:00.000Z",
							digest: "sha256:newest",
							retention_days: 3,
						},
						{ id: "incomplete", status: "created", created_at: "2026-09-21T11:00:00.000Z" },
					],
					BackupObserver.use((observer) => observer.run(backup, "backup-observer")),
				);
				expect(outcome).toBe("succeeded");
				const deployment = Option.getOrThrow(yield* (yield* Deployments).get(board.id));
				expect(deployment).toMatchObject({
					last_snapshot_id: "newest",
					last_snapshot_digest: "sha256:newest",
					last_snapshot_retention_days: 3,
				});
				expect(deployment.last_snapshot_created_at?.toISOString()).toBe("2026-09-19T11:00:00.000Z");
				const db = yield* Database;
				expect(
					yield* db
						.select({ state: boardOperations.state })
						.from(boardOperations)
						.where(eq(boardOperations.id, backup.id)),
				).toEqual([{ state: "succeeded" }]);
			}),
		);
	});

	test("fails the observation without blocking later work when Fly has no completed snapshot", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { backup, board } = yield* prepare;
				const outcome = yield* runObserver(
					[{ id: "pending", status: "pending", created_at: "2026-09-20T12:00:00.000Z" }],
					BackupObserver.use((observer) => observer.run(backup, "backup-observer")),
				);
				expect(outcome).toBe("failed");
				expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id)).last_snapshot_id).toBeNull();
				const db = yield* Database;
				expect(
					yield* db
						.select({ state: boardOperations.state, last_error_code: boardOperations.last_error_code })
						.from(boardOperations)
						.where(eq(boardOperations.id, backup.id)),
				).toEqual([{ state: "failed", last_error_code: "snapshot_pending" }]);
				expect(
					(yield* (yield* Operations).enqueue({
						board_id: board.id,
						owner_id: board.owner_id,
						kind: "backup",
						requested_by: board.owner_id,
						idempotency_key: "backup-after-backup-observation",
					})).state,
				).toBe("queued");
			}),
		);
	});

	test("rejects invalid retention metadata and releases the board slot", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { backup, board } = yield* prepare;
				const outcome = yield* runObserver(
					[
						{
							id: "invalid",
							created_at: "2026-09-20T11:00:00.000Z",
							digest: "sha256:invalid",
							retention_days: -1,
						},
					],
					BackupObserver.use((observer) => observer.run(backup, "backup-observer")),
				);
				expect(outcome).toBe("failed");
				const db = yield* Database;
				expect(
					yield* db
						.select({ state: boardOperations.state, last_error_code: boardOperations.last_error_code })
						.from(boardOperations)
						.where(eq(boardOperations.id, backup.id)),
				).toEqual([{ state: "failed", last_error_code: "snapshot_pending" }]);
				expect(
					(yield* (yield* Operations).enqueue({
						board_id: board.id,
						owner_id: board.owner_id,
						kind: "backup",
						requested_by: board.owner_id,
						idempotency_key: "backup-after-invalid-metadata",
					})).state,
				).toBe("queued");
			}),
		);
	});

	test("rejects a stale lease before observing the provider", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { backup } = yield* prepare;
				if (!backup.lease_token) return yield* Effect.die("Backup claim returned no lease token");
				yield* (yield* Operations).requeue({
					id: backup.id,
					leaseToken: backup.lease_token,
					workerId: "backup-observer",
					availableAt: new Date(Date.now() + 60_000),
					errorCode: "test",
					errorMessage: "test",
				});
				const observed = { calls: 0 };
				const exit = yield* Effect.exit(
					BackupObserver.use((observer) => observer.run(backup, "backup-observer")).pipe(
						Effect.provide(backupObserverLayer.pipe(Layer.provide(flyLayer([], observed)))),
					),
				);
				expect(exit._tag).toBe("Failure");
				expect(observed.calls).toBe(0);
			}),
		);
	});
});
