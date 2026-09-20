import { DateTime, Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import * as foundation from "../src/migrations/0001_foundation.ts";
import * as cloudAuth from "../src/migrations/0002_cloud_auth.ts";
import * as flyProvisioning from "../src/migrations/0003_fly_provisioning.ts";
import { cloudMigrations } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";
import { request, settings } from "./fixtures/provisioner.ts";

const legacy = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const database = yield* Database;
	yield* sql`CREATE TABLE cloud_migrations (
		migration_id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		compatible_schema_versions INTEGER[] NOT NULL DEFAULT '{}',
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`;
	for (const migration of [foundation, cloudAuth, flyProvisioning]) {
		yield* migration.effect(database);
		yield* database.insert(cloudMigrations).values({
			migration_id: migration.id,
			name: migration.name,
			compatible_schema_versions: [...migration.compatibleSchemaVersions],
		});
	}
	yield* sql`ALTER TABLE board_operations ADD COLUMN ambiguous_mutations TEXT[] NOT NULL DEFAULT '{}'::text[]`;
	return sql;
});

describe("provisioning recovery migration", () => {
	test("maps live and blocked checkpoints without losing identities, snapshot records, or operation history", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* legacy;
				for (const state of ["runtime_secrets_written", "blocked"]) {
					const board = yield* (yield* Boards).request({ ...request, idempotency_key: state });
					yield* sql`INSERT INTO board_deployments (board_id, state, hostname, storage_engine, region, image_ref,
					app_name, network_name, volume_name, machine_name, volume_size_gb, app_id, volume_id,
					last_snapshot_id, last_snapshot_digest, last_snapshot_created_at, last_snapshot_retention_days)
					VALUES (${board.id}, ${state}, ${board.slug}, 'sqlite', 'sjc', ${settings.imageRef},
					${board.slug}, ${board.slug}, ${board.slug}, ${board.slug}, 1, 'app-id', ${board.slug},
					'snapshot-id', 'snapshot-digest', '2026-09-20T12:00:00Z', 5)`;
					yield* sql`UPDATE board_operations SET checkpoint = 'runtime_secrets_written', attempt = 3,
					last_error_code = ${state === "blocked" ? "retry_exhausted" : "provider_unavailable"},
					state = ${state === "blocked" ? "failed" : "queued"},
					finished_at = ${state === "blocked" ? DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-20T12:00:00Z")) : null}
					WHERE board_id = ${board.id}`;
				}
				const before = yield* sql`SELECT board_id, app_id, volume_id, last_snapshot_id, last_snapshot_digest,
				last_snapshot_created_at::text, last_snapshot_retention_days FROM board_deployments ORDER BY board_id`;
				yield* sql`ALTER TABLE board_operations DROP COLUMN ambiguous_mutations`;
				yield* migrateCloudDatabase;
				yield* migrateCloudDatabase;
				expect(
					yield* sql`SELECT board_id, app_id, volume_id, last_snapshot_id, last_snapshot_digest,
				last_snapshot_created_at::text, last_snapshot_retention_days FROM board_deployments ORDER BY board_id`,
				).toEqual(before);
				expect(yield* sql`SELECT state FROM board_deployments ORDER BY state`).toEqual([
					{ state: "blocked" },
					{ state: "volume_created" },
				]);
				expect(
					yield* sql`SELECT checkpoint, attempt, state, ambiguous_mutations FROM board_operations ORDER BY state`,
				).toEqual([
					{ checkpoint: "volume_created", attempt: 3, state: "failed", ambiguous_mutations: ["machine_create"] },
					{ checkpoint: "volume_created", attempt: 3, state: "queued", ambiguous_mutations: ["machine_create"] },
				]);
				expect(
					yield* sql`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema()
				AND table_name IN ('board_operations', 'board_deployments') AND column_name IN ('desired_revision', 'secrets_version')`,
				).toEqual([]);
				expect(
					Exit.isFailure(yield* Effect.exit(sql`UPDATE board_deployments SET state = 'runtime_secrets_written'`)),
				).toBe(true);
			}),
		);
	});

	test("conservatively marks a legacy running edge checkpoint with no recorded error", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* legacy;
				const board = yield* (yield* Boards).request({ ...request, idempotency_key: "legacy-running" });
				yield* sql`INSERT INTO board_deployments (board_id, state, hostname, storage_engine, region, image_ref,
					app_name, network_name, volume_name, machine_name, volume_size_gb, app_id, volume_id, machine_id)
					VALUES (${board.id}, 'machine_started', ${board.slug}, 'sqlite', 'sjc', ${settings.imageRef},
					${board.slug}, ${board.slug}, ${board.slug}, ${board.slug}, 1, 'app-id', 'volume-id', 'machine-id')`;
				yield* sql`UPDATE board_operations SET checkpoint = 'machine_started', state = 'running',
					lease_token = '00000000-0000-4000-8000-000000000001', lease_owner = 'stopped-old-worker',
					lease_expires_at = clock_timestamp() - interval '1 second'
					WHERE board_id = ${board.id}`;
				yield* sql`ALTER TABLE board_operations DROP COLUMN ambiguous_mutations`;
				yield* migrateCloudDatabase;
				expect(yield* sql`SELECT ambiguous_mutations FROM board_operations WHERE board_id = ${board.id}`).toEqual([
					{
						ambiguous_mutations: ["machine_start", "edge_ip", "edge_certificate", "edge_a_record", "edge_txt_record"],
					},
				]);
			}),
		);
	});

	test("copies legacy ambiguity into an already queued operator retry", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* legacy;
				const board = yield* (yield* Boards).request({ ...request, idempotency_key: "legacy-retry" });
				yield* sql`INSERT INTO board_deployments (board_id, state, hostname, storage_engine, region, image_ref,
					app_name, network_name, volume_name, machine_name, volume_size_gb, app_id, volume_id)
					VALUES (${board.id}, 'blocked', ${board.slug}, 'sqlite', 'sjc', ${settings.imageRef},
					${board.slug}, ${board.slug}, ${board.slug}, ${board.slug}, 1, 'app-id', 'volume-id')`;
				yield* sql`UPDATE board_operations SET checkpoint = 'runtime_secrets_written', state = 'failed',
					last_error_code = 'provider_rejected', last_error_message = 'legacy readback rejected',
					finished_at = clock_timestamp()
					WHERE board_id = ${board.id}`;
				yield* sql`INSERT INTO board_operations (
					id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash
				)
				SELECT '00000000-0000-4000-8000-000000000002', board_id, kind, 'queued', checkpoint,
					'operator:deployment-retry', id::text, request_hash
				FROM board_operations WHERE board_id = ${board.id}`;
				yield* sql`ALTER TABLE board_operations DROP COLUMN ambiguous_mutations`;
				yield* migrateCloudDatabase;
				expect(
					yield* sql`SELECT requested_by, ambiguous_mutations FROM board_operations
						WHERE board_id = ${board.id} ORDER BY requested_by`,
				).toEqual([
					{ requested_by: "operator:deployment-retry", ambiguous_mutations: ["machine_create"] },
					{ requested_by: "user-1", ambiguous_mutations: ["machine_create"] },
				]);
			}),
		);
	});

	test("rolls back checkpoint rewrites when a later migration statement fails", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* legacy;
				yield* (yield* Boards).request(request);
				yield* sql`UPDATE board_operations SET checkpoint = 'runtime_secrets_written'`;
				yield* sql`ALTER TABLE board_operations DROP COLUMN ambiguous_mutations`;
				yield* sql`ALTER TABLE board_deployments RENAME CONSTRAINT board_deployments_state_check TO unexpected_state_check`;
				expect(Exit.isFailure(yield* Effect.exit(migrateCloudDatabase))).toBe(true);
				expect(yield* sql`SELECT checkpoint FROM board_operations`).toEqual([
					{ checkpoint: "runtime_secrets_written" },
				]);
				expect(yield* sql`SELECT migration_id FROM cloud_migrations ORDER BY migration_id`).toEqual([
					{ migration_id: 1 },
					{ migration_id: 2 },
					{ migration_id: 3 },
				]);
			}),
		);
	});
});
