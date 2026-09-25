import { sql as drizzleSql } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import type { DatabaseClient } from "../src/database.ts";
import { runCloudMigrations } from "../src/migrations.ts";
import * as foundation from "../src/migrations/0001_foundation.ts";
import { runFresh } from "./fixture.ts";

describe("Cloud image rollback compatibility", () => {
	test("permits an older image only when every newer receipt declares it compatible, without rewriting receipts", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const newer = [
					foundation,
					{
						id: 2,
						name: "additive",
						compatibleSchemaVersions: [1],
						effect: (database: DatabaseClient) =>
							database.execute(drizzleSql`ALTER TABLE boards ADD COLUMN description TEXT`).pipe(Effect.asVoid),
					},
					{ id: 3, name: "still_additive", compatibleSchemaVersions: [1, 2], effect: () => Effect.void },
				];
				yield* runCloudMigrations(newer);
				const before = yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`;
				yield* runCloudMigrations([foundation]);
				yield* runCloudMigrations([foundation]);
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'After rollback', ${"a".repeat(32)}, 'sqlite')`;
				yield* runCloudMigrations(newer);
				expect(yield* sql`SELECT name, description FROM boards`).toEqual([
					{ name: "After rollback", description: null },
				]);
				expect(yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`).toEqual(before);
			}),
		);
	});

	test.each([
		{ second: [], third: [1, 2], refused: 2 },
		{ second: [1], third: [2], refused: 3 },
	])(
		"refuses rollback across incompatible migration $refused even if another admits the image",
		async ({ second, third, refused }) => {
			await runFresh(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* runCloudMigrations([
						foundation,
						{ id: 2, name: "second", compatibleSchemaVersions: second, effect: () => Effect.void },
						{ id: 3, name: "third", compatibleSchemaVersions: third, effect: () => Effect.void },
					]);
					const before = yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`;
					const result = yield* Effect.exit(runCloudMigrations([foundation]));
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) {
						expect(result.cause.toString()).toContain(`Cloud schema 1: newer migration ${refused}`);
						expect(result.cause.toString()).toContain("does not explicitly declare this image compatible");
					}
					expect(yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`).toEqual(before);
				}),
			);
		},
	);

	test("rejects editing a known compatibility declaration", async () => {
		await runFresh(
			Effect.gen(function* () {
				const second = { id: 2, name: "second", compatibleSchemaVersions: [1], effect: () => Effect.void };
				yield* runCloudMigrations([foundation, second]);
				const result = yield* Effect.exit(
					runCloudMigrations([foundation, { ...second, compatibleSchemaVersions: [] }]),
				);
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("immutable registry");
			}),
		);
	});

	test("accepts an explicitly declared historical receipt variant without rewriting it", async () => {
		await runFresh(
			Effect.gen(function* () {
				const historical = { id: 2, name: "second", compatibleSchemaVersions: [], effect: () => Effect.void };
				yield* runCloudMigrations([foundation, historical]);
				const sql = yield* SqlClient.SqlClient;
				const before = yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`;
				yield* runCloudMigrations([
					foundation,
					{
						...historical,
						compatibleSchemaVersions: [1],
						acceptedCompatibleSchemaVersions: [[]],
					},
				]);
				expect(yield* sql`SELECT * FROM cloud_migrations ORDER BY migration_id`).toEqual(before);
			}),
		);
	});

	test("does not accept a missing known receipt as a compatible upgrade", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* runCloudMigrations([foundation]);
				yield* sql`INSERT INTO cloud_migrations (migration_id, name, compatible_schema_versions)
					VALUES (3, 'missing_second', '{1,2}')`;
				const result = yield* Effect.exit(
					runCloudMigrations([
						foundation,
						{ id: 2, name: "second", compatibleSchemaVersions: [1], effect: () => Effect.die("must not run") },
					]),
				);
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("invalid migration ledger at version 3");
			}),
		);
	});

	test("refuses malformed newer compatibility metadata", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* runCloudMigrations([foundation]);
				yield* sql`INSERT INTO cloud_migrations (migration_id, name, compatible_schema_versions)
					VALUES (2, 'malformed', '{1,NULL}')`;
				const result = yield* Effect.exit(runCloudMigrations([foundation]));
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("schema readiness cannot be verified");
			}),
		);
	});

	test("refuses an old ledger format rather than inventing compatibility metadata", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE cloud_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
				yield* sql`INSERT INTO cloud_migrations VALUES (1, 'foundation')`;
				const before = yield* sql`SELECT * FROM cloud_migrations`;
				const result = yield* Effect.exit(runCloudMigrations([foundation]));
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result))
					expect(result.cause.toString()).toContain("Cloud schema 1: migration ledger is unreadable");
				expect(yield* sql`SELECT * FROM cloud_migrations`).toEqual(before);
			}),
		);
	});
});
