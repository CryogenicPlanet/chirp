import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Database } from "../src/database.ts";
import { CloudMigrationError, migrateCloudDatabase } from "../src/migrations.ts";
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
					.select({ migration_id: cloudMigrations.migration_id, name: cloudMigrations.name })
					.from(cloudMigrations);
				expect(receipts).toEqual([{ migration_id: 1, name: "foundation" }]);
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

	test("refuses a migration newer than the static registry", async () => {
		await runFresh(
			Effect.gen(function* () {
				const database = yield* Database;
				yield* migrateCloudDatabase;
				yield* database.insert(cloudMigrations).values({ migration_id: 2, name: "unknown" });
				const result = yield* Effect.exit(migrateCloudDatabase);
				expect(Exit.isFailure(result)).toBe(true);
			}),
		);
	});

	test.skipIf(!realPostgres)("rolls back DDL when writing the receipt fails", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE cloud_migrations (
					migration_id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					created_at TIMESTAMPTZ NOT NULL DEFAULT now()
				)`;
				yield* sql`CREATE FUNCTION reject_cloud_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'receipt rejected'; END
				$$`;
				yield* sql`CREATE TRIGGER reject_cloud_receipt BEFORE INSERT ON cloud_migrations
					FOR EACH ROW EXECUTE FUNCTION reject_cloud_receipt()`;
				expect(Exit.isFailure(yield* Effect.exit(migrateCloudDatabase))).toBe(true);
				const tables = yield* sql`SELECT table_name FROM information_schema.tables
					WHERE table_schema = current_schema() AND table_name IN ('boards', 'board_operations')`;
				expect(tables).toEqual([]);
				yield* sql`DROP FUNCTION reject_cloud_receipt() CASCADE`;
			}),
		);
	});
});
