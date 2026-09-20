import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { describe, expect, test } from "vitest";
import { BackupScheduler, backupSchedulerLayer } from "../src/backup-scheduler.ts";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { Deployments } from "../src/deployments.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { boardDeployments } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";

const request = {
	owner_id: "user-1",
	name: "Managed board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-backup-scheduler",
} as const;

const prepare = Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const board = yield* (yield* Boards).request(request);
	const operations = yield* Operations;
	const provision = Option.getOrThrow(yield* operations.claim("provisioner", 30_000, "provision"));
	if (!provision.lease_token) return yield* Effect.die("Provision claim returned no lease token");
	const lease = { operationId: provision.id, leaseToken: provision.lease_token, workerId: "provisioner" };
	const deployments = yield* Deployments;
	let deployment = yield* deployments.ensure({
		...lease,
		spec: {
			hostname: "0123456789abcdef0123456789abcdef.boards.chirp.wiki",
			region: "sjc",
			image_ref: `registry.example/chirp@sha256:${"a".repeat(64)}`,
			app_name: "chirp-0123456789abcdef0123456789abcdef",
			network_name: "chirp-0123456789abcdef0123456789abcdef",
			volume_name: "chirp_data_0123456789abcdef0123456789abcdef",
			machine_name: "board-0123456789abcdef0123456789abcdef",
			volume_size_gb: 1,
		},
	});
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
			...(next === "volume_created" ? { volumeId: "volume-id" } : {}),
		});
	}
	yield* operations.succeed(provision.id, lease.leaseToken, lease.workerId);
	return { board, operations };
});

const schedule = BackupScheduler.use((scheduler) => scheduler.scheduleDue).pipe(Effect.provide(backupSchedulerLayer));

describe("BackupScheduler", () => {
	test("enqueues one backup for a provisioned board with no verified snapshot", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board, operations } = yield* prepare;
				expect(yield* schedule).toBe(1);
				expect(yield* schedule).toBe(0);
				const backup = Option.getOrThrow(yield* operations.claim("backup-worker", 30_000, "backup"));
				expect(backup).toMatchObject({ board_id: board.id, kind: "backup", requested_by: "system:backup" });
			}),
		);
	});

	test("enqueues only after the verified snapshot is 24 hours old", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board } = yield* prepare;
				const db = yield* Database;
				yield* db
					.update(boardDeployments)
					.set({
						last_snapshot_id: "snapshot-id",
						last_snapshot_created_at: sql`clock_timestamp()`,
						last_snapshot_digest: "sha256:digest",
						last_snapshot_retention_days: 5,
					})
					.where(eq(boardDeployments.board_id, board.id));
				expect(yield* schedule).toBe(0);
				yield* db
					.update(boardDeployments)
					.set({ last_snapshot_created_at: sql`clock_timestamp() - interval '25 hours'` })
					.where(eq(boardDeployments.board_id, board.id));
				expect(yield* schedule).toBe(1);
			}),
		);
	});
});
