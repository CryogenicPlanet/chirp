import { asc, eq, sql as drizzleSql } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Database, type DatabaseClient } from "../src/database.ts";
import { CloudMigrationError } from "../src/migration-ledger.ts";
import { migrateCloudDatabase, runCloudMigrations } from "../src/migrations.ts";
import * as foundation from "../src/migrations/0001_foundation.ts";
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
				]);
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
					.values({ migration_id: 7, name: "unknown", compatible_schema_versions: [] });
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
});
