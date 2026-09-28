import { asc, eq, sql as drizzleSql } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Database, type DatabaseClient } from "../src/database.ts";
import { CloudMigrationError } from "../src/migration-ledger.ts";
import { migrateCloudDatabase, runCloudMigrations } from "../src/migrations.ts";
import * as foundation from "../src/migrations/0001_foundation.ts";
import * as cloudAuth from "../src/migrations/0002_cloud_auth.ts";
import * as postgresSecrets from "../src/migrations/0009_board_postgres_secrets.ts";
import * as provisioningTemplateV2 from "../src/migrations/0013_provisioning_template_v2.ts";
import * as boardPostgresSecretStages from "../src/migrations/0014_board_postgres_secret_stages.ts";
import { cloudMigrations } from "../src/schema.ts";
import { realPostgres, runFresh } from "./fixture.ts";

describe("cloud migrations", () => {
	test("applies the static registry and reruns idempotently", async () => {
		await runFresh(
			Effect.gen(function* () {
				const database = yield* Database;
				yield* migrateCloudDatabase;
				yield* migrateCloudDatabase;
				const receipts = yield* database
					.select({
						migration_id: cloudMigrations.migration_id,
						name: cloudMigrations.name,
						compatibleSchemaVersions: cloudMigrations.compatible_schema_versions,
					})
					.from(cloudMigrations)
					.orderBy(asc(cloudMigrations.migration_id));
				expect(receipts).toEqual([
					{ migration_id: 1, name: "foundation", compatibleSchemaVersions: [] },
					{ migration_id: 2, name: "cloud_auth", compatibleSchemaVersions: [1] },
					{ migration_id: 3, name: "fly_provisioning", compatibleSchemaVersions: [1, 2] },
					{ migration_id: 4, name: "provisioning_recovery", compatibleSchemaVersions: [] },
					{ migration_id: 5, name: "provider_mutation_markers", compatibleSchemaVersions: [] },
					{ migration_id: 6, name: "provisioning_retry_budgets", compatibleSchemaVersions: [] },
					{ migration_id: 7, name: "board_deletion", compatibleSchemaVersions: [] },
					{ migration_id: 8, name: "invitation_limits", compatibleSchemaVersions: [] },
					{ migration_id: 9, name: "board_postgres_secrets", compatibleSchemaVersions: [1, 2, 3, 4, 5, 6, 7, 8] },
					{ migration_id: 10, name: "readable_board_slugs", compatibleSchemaVersions: [] },
					{ migration_id: 11, name: "generic_invitations", compatibleSchemaVersions: [] },
					{ migration_id: 12, name: "board_release_channel", compatibleSchemaVersions: [11] },
					{ migration_id: 13, name: "provisioning_template_v2", compatibleSchemaVersions: [] },
					{ migration_id: 14, name: "board_postgres_secret_stages", compatibleSchemaVersions: [] },
				]);
			}),
		);
	});

	test("upgrades the immutable migration 9 table through a forward migration", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* runCloudMigrations([foundation]);
				const database = yield* Database;
				const sql = yield* SqlClient.SqlClient;
				yield* postgresSecrets.effect(database);
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES
						('00000000-0000-4000-8000-000000000001', 'owner', 'Postgres', ${"a".repeat(32)}, 'postgres'),
						('00000000-0000-4000-8000-000000000002', 'owner', 'Prepared', ${"b".repeat(32)}, 'postgres')`;
				yield* sql`INSERT INTO board_postgres_secrets (board_id, ciphertext)
					VALUES
						('00000000-0000-4000-8000-000000000001', 'encrypted-bootstrap'),
						('00000000-0000-4000-8000-000000000002', 'encrypted-prepared')`;
				yield* sql`UPDATE board_postgres_secrets SET prepared = true, fly_secrets_version = 17
					WHERE board_id = '00000000-0000-4000-8000-000000000002'`;
				yield* database.transaction((transaction) => boardPostgresSecretStages.effect(transaction));
				expect(yield* sql`SELECT * FROM board_postgres_secrets`).toEqual([
					{
						board_id: "00000000-0000-4000-8000-000000000001",
						bootstrap_ciphertext: "encrypted-bootstrap",
						runtime_ciphertext: null,
						prepared: false,
						fly_secrets_version: null,
					},
					{
						board_id: "00000000-0000-4000-8000-000000000002",
						bootstrap_ciphertext: "encrypted-prepared",
						runtime_ciphertext: null,
						prepared: true,
						fly_secrets_version: 17,
					},
				]);
				expect(
					yield* sql`SELECT is_nullable FROM information_schema.columns
						WHERE table_name = 'board_postgres_secrets' AND column_name = 'bootstrap_ciphertext'`,
				).toEqual([{ is_nullable: "YES" }]);
			}),
		);
	});

	test("upgrades the current-master staged migration 9 schema without rewriting its receipt", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`DELETE FROM cloud_migrations WHERE migration_id >= 13`;
				yield* sql`UPDATE cloud_migrations SET compatible_schema_versions = ARRAY[]::integer[] WHERE migration_id = 9`;
				yield* sql`ALTER TABLE board_postgres_secrets DROP CONSTRAINT board_postgres_secrets_stage_check`;
				yield* sql`ALTER TABLE board_postgres_secrets ADD CONSTRAINT board_postgres_secrets_stage_check CHECK (
					(NOT prepared AND bootstrap_ciphertext IS NOT NULL AND runtime_ciphertext IS NULL)
					OR (prepared AND bootstrap_ciphertext IS NULL AND runtime_ciphertext IS NOT NULL)
				)`;
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES
						('00000000-0000-4000-8000-000000000001', 'owner', 'Bootstrap', ${"a".repeat(32)}, 'postgres'),
						('00000000-0000-4000-8000-000000000002', 'owner', 'Runtime', ${"b".repeat(32)}, 'postgres')`;
				yield* sql`INSERT INTO board_postgres_secrets (
					board_id, bootstrap_ciphertext, runtime_ciphertext, prepared, fly_secrets_version
				) VALUES
					('00000000-0000-4000-8000-000000000001', 'encrypted-bootstrap', NULL, false, NULL),
					('00000000-0000-4000-8000-000000000002', NULL, 'encrypted-runtime', true, 17)`;
				yield* migrateCloudDatabase;
				expect(
					yield* sql`SELECT migration_id, compatible_schema_versions FROM cloud_migrations
						WHERE migration_id IN (9, 12, 13, 14) ORDER BY migration_id`,
				).toEqual([
					{ migration_id: 9, compatible_schema_versions: [] },
					{ migration_id: 12, compatible_schema_versions: [11] },
					{ migration_id: 13, compatible_schema_versions: [] },
					{ migration_id: 14, compatible_schema_versions: [] },
				]);
				expect(
					yield* sql`SELECT board_id, bootstrap_ciphertext, runtime_ciphertext, prepared, fly_secrets_version
						FROM board_postgres_secrets ORDER BY board_id`,
				).toEqual([
					{
						board_id: "00000000-0000-4000-8000-000000000001",
						bootstrap_ciphertext: "encrypted-bootstrap",
						runtime_ciphertext: null,
						prepared: false,
						fly_secrets_version: null,
					},
					{
						board_id: "00000000-0000-4000-8000-000000000002",
						bootstrap_ciphertext: null,
						runtime_ciphertext: "encrypted-runtime",
						prepared: true,
						fly_secrets_version: 17,
					},
				]);
				yield* sql`UPDATE board_postgres_secrets SET prepared = true
					WHERE board_id = '00000000-0000-4000-8000-000000000001'`;
			}),
		);
	});

	test("refuses a changed historical receipt", async () => {
		await runFresh(
			Effect.gen(function* () {
				const database = yield* Database;
				yield* migrateCloudDatabase;
				yield* database.update(cloudMigrations).set({ name: "changed" }).where(eq(cloudMigrations.migration_id, 1));
				const result = yield* Effect.exit(migrateCloudDatabase);
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) expect(result.cause.toString()).toContain(CloudMigrationError.name);
			}),
		);
	});

	test("refuses an incompatible migration newer than the static registry", async () => {
		await runFresh(
			Effect.gen(function* () {
				const database = yield* Database;
				yield* migrateCloudDatabase;
				yield* database
					.insert(cloudMigrations)
					.values({ migration_id: 15, name: "unknown", compatible_schema_versions: [] });
				const result = yield* Effect.exit(migrateCloudDatabase);
				expect(Exit.isFailure(result)).toBe(true);
			}),
		);
	});

	test.skipIf(!realPostgres)(
		"serializes concurrent fresh migrations before reading or creating the ledger",
		async () => {
			await runFresh(
				Effect.gen(function* () {
					const client = yield* SqlClient.SqlClient;
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const registry = [
						{
							...foundation,
							effect: (database: DatabaseClient) =>
								Effect.gen(function* () {
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(release);
									yield* foundation.effect(database);
								}),
						},
					];
					const first = yield* Effect.forkChild(runCloudMigrations(registry));
					yield* Deferred.await(entered);
					const second = yield* Effect.forkChild(runCloudMigrations(registry));
					let waiting = false;
					for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
						const locks = yield* client`SELECT pid FROM pg_locks
							WHERE locktype = 'advisory' AND NOT granted
							AND classid = (485017403101::bigint >> 32)::oid
							AND objid = (485017403101::bigint & 4294967295)::oid`;
						waiting = locks.length > 0;
						if (!waiting) yield* Effect.sleep("10 millis");
					}
					expect(waiting).toBe(true);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(first);
					yield* Fiber.join(second);
					expect(yield* client`SELECT migration_id FROM cloud_migrations`).toEqual([{ migration_id: 1 }]);
				}),
			);
		},
	);

	test("rolls back a failed upgrade and can restart without changing acknowledged data or receipts", async () => {
		await runFresh(
			Effect.gen(function* () {
				const client = yield* SqlClient.SqlClient;
				yield* runCloudMigrations([foundation]);
				yield* client`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'Retained', ${"a".repeat(32)}, 'sqlite')`;
				const before = yield* client`SELECT * FROM cloud_migrations`;
				const upgrade = {
					id: 2,
					name: "additive",
					compatibleSchemaVersions: [1],
					effect: (database: DatabaseClient) =>
						database.execute(drizzleSql`ALTER TABLE boards ADD COLUMN description TEXT`).pipe(Effect.asVoid),
				};
				const failed = yield* Effect.exit(
					runCloudMigrations([
						foundation,
						{
							...upgrade,
							effect: (database: DatabaseClient) =>
								upgrade
									.effect(database)
									.pipe(
										Effect.andThen(database.execute(drizzleSql`SELECT * FROM absent_migration_table`)),
										Effect.asVoid,
									),
						},
					]),
				);
				expect(Exit.isFailure(failed)).toBe(true);
				expect(yield* client`SELECT * FROM cloud_migrations`).toEqual(before);
				yield* runCloudMigrations([foundation]);
				yield* runCloudMigrations([foundation, upgrade]);
				expect(yield* client`SELECT name, description FROM boards`).toEqual([{ name: "Retained", description: null }]);
			}),
		);
	});

	test.skipIf(!realPostgres)("rolls back DDL when writing the receipt fails", async () => {
		await runFresh(
			Effect.gen(function* () {
				const client = yield* SqlClient.SqlClient;
				yield* client`CREATE TABLE cloud_migrations (
					migration_id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					compatible_schema_versions INTEGER[] NOT NULL DEFAULT '{}',
					created_at TIMESTAMPTZ NOT NULL DEFAULT now()
				)`;
				yield* client`CREATE FUNCTION reject_cloud_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'receipt rejected'; END
				$$`;
				yield* client`CREATE TRIGGER reject_cloud_receipt BEFORE INSERT ON cloud_migrations
					FOR EACH ROW EXECUTE FUNCTION reject_cloud_receipt()`;
				expect(Exit.isFailure(yield* Effect.exit(migrateCloudDatabase))).toBe(true);
				const tables = yield* client`SELECT table_name FROM information_schema.tables
					WHERE table_schema = current_schema() AND table_name IN ('boards', 'board_operations')`;
				expect(tables).toEqual([]);
				yield* client`DROP FUNCTION reject_cloud_receipt() CASCADE`;
			}),
		);
	});
	test("preserves legacy names and hex addresses when enabling readable slugs", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* runCloudMigrations([foundation]);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
    VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'Original name', ${"a".repeat(32)}, 'sqlite')`;
				yield* migrateCloudDatabase;
				expect(yield* sql`SELECT name, slug FROM boards`).toEqual([{ name: "Original name", slug: "a".repeat(32) }]);
			}),
		);
	});
	test("preserves existing email restrictions when enabling generic invitations", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* runCloudMigrations([foundation, cloudAuth]);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO cloud_invitations (id, token_digest, email, expires_at, created_at)
				VALUES ('legacy-invite', ${"a".repeat(64)}, 'person@example.com', now() + interval '1 day', now())`;
				const before = yield* sql`SELECT * FROM cloud_invitations`;
				yield* migrateCloudDatabase;
				expect(yield* sql`SELECT * FROM cloud_invitations`).toEqual(before);
				yield* sql`INSERT INTO cloud_invitations (id, token_digest, email, expires_at, created_at)
				VALUES ('generic-invite', ${"b".repeat(64)}, NULL, now() + interval '1 day', now())`;
				expect(yield* sql`SELECT email FROM cloud_invitations WHERE id = 'generic-invite'`).toEqual([{ email: null }]);
			}),
		);
	});

	test("upgrades only uncreated legacy volume intent to the supported template", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const sql = yield* SqlClient.SqlClient;
				const boardId = "00000000-0000-4000-8000-000000000001";
				const operationId = "00000000-0000-4000-8000-000000000002";
				const normalizedBoardId = "00000000-0000-4000-8000-000000000003";
				const normalizedOperationId = "00000000-0000-4000-8000-000000000004";
				const ambiguousBoardId = "00000000-0000-4000-8000-000000000005";
				const ambiguousOperationId = "00000000-0000-4000-8000-000000000006";
				const slug = "a".repeat(32);
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES (${boardId}, 'owner', 'Legacy', ${slug}, 'sqlite')`;
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine) VALUES
					(${normalizedBoardId}, 'owner', 'Normalized', ${"b".repeat(32)}, 'sqlite'),
					(${ambiguousBoardId}, 'owner', 'Ambiguous', ${"c".repeat(32)}, 'sqlite')`;
				yield* sql`INSERT INTO board_deployments (
					board_id, state, hostname, storage_engine, region, image_ref, app_name, network_name,
					volume_name, machine_name, volume_size_gb
				) VALUES (
					${boardId}, 'app_created', ${`${slug}.boards.chirp.wiki`}, 'sqlite', 'sjc',
					${`registry.example/chirp@sha256:${"a".repeat(64)}`}, ${`chirp-${slug}`}, ${`chirp-${slug}`},
					${`chirp_data_${slug}`}, ${`board-${slug}`}, 1
				)`;
				for (const [id, value] of [
					[normalizedBoardId, "b".repeat(32)],
					[ambiguousBoardId, "c".repeat(32)],
				] as const)
					yield* sql`INSERT INTO board_deployments (
						board_id, state, hostname, storage_engine, region, image_ref, app_name, network_name,
						volume_name, machine_name, volume_size_gb
					) VALUES (
						${id}, 'app_created', ${`${value}.boards.chirp.wiki`}, 'sqlite', 'sjc',
						${`registry.example/chirp@sha256:${"a".repeat(64)}`}, ${`chirp-${value}`}, ${`chirp-${value}`},
						${id === ambiguousBoardId ? `chirp_data_${value}` : "chirp_data"}, ${`board-${value}`}, 1
					)`;
				yield* sql`INSERT INTO board_operations (
					id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash
				) VALUES (
					${operationId}, ${boardId}, 'provision', 'queued', 'app_created', 'owner', 'legacy',
					${"a".repeat(64)}
				)`;
				for (const [id, board, marker] of [
					[normalizedOperationId, normalizedBoardId, false],
					[ambiguousOperationId, ambiguousBoardId, true],
				] as const) {
					if (marker)
						yield* sql`INSERT INTO board_operations (
							id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash,
							ambiguous_mutations
						) VALUES (
							${id}, ${board}, 'provision', 'queued', 'app_created', 'owner', ${id},
							${"b".repeat(64)}, ARRAY['volume_create']::text[]
						)`;
					else
						yield* sql`INSERT INTO board_operations (
							id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash
						) VALUES (
							${id}, ${board}, 'provision', 'queued', 'app_created', 'owner', ${id}, ${"b".repeat(64)}
						)`;
				}
				yield* provisioningTemplateV2.effect(yield* Database);
				expect(
					yield* sql`SELECT board_id, volume_name, volume_size_gb, row_version FROM board_deployments ORDER BY board_id`,
				).toEqual([
					{ board_id: boardId, volume_name: "chirp_data", volume_size_gb: 1, row_version: 1 },
					{ board_id: normalizedBoardId, volume_name: "chirp_data", volume_size_gb: 1, row_version: 0 },
					{
						board_id: ambiguousBoardId,
						volume_name: `chirp_data_${"c".repeat(32)}`,
						volume_size_gb: 1,
						row_version: 0,
					},
				]);
				expect(yield* sql`SELECT id, ambiguous_mutations FROM board_operations ORDER BY id`).toEqual([
					{ id: operationId, ambiguous_mutations: [] },
					{ id: normalizedOperationId, ambiguous_mutations: [] },
					{ id: ambiguousOperationId, ambiguous_mutations: ["volume_create"] },
				]);
			}),
		);
	});
});
