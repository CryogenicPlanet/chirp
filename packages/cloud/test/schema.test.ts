import { getTableConfig } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { boardOperations, boards } from "../src/schema.ts";
import { realPostgres, runFresh } from "./fixture.ts";

const constraintNames = () =>
	[boards, boardOperations]
		.flatMap((table) => {
			const config = getTableConfig(table);
			return [
				...config.checks.map(({ name }) => name),
				...config.uniqueConstraints.map(({ name }) => name),
				...config.foreignKeys.map((foreignKey) => foreignKey.getName()),
			];
		})
		.sort();

describe("Cloud Drizzle schema", () => {
	test("declares the foundation checks and C-collated opaque identifiers", () => {
		expect(constraintNames()).toEqual(
			expect.arrayContaining([
				"board_operations_attempt_nonnegative",
				"board_operations_board_id_boards_id_fk",
				"board_operations_finished_shape",
				"board_operations_kind_check",
				"board_operations_lease_shape",
				"board_operations_request_hash_hex",
				"board_operations_request_unique",
				"board_operations_state_check",
				"boards_name_nonempty",
				"boards_slug_hex",
				"boards_slug_unique",
				"boards_storage_engine_check",
			]),
		);
		expect(
			getTableConfig(boards)
				.columns.find(({ name }) => name === "slug")
				?.getSQLType(),
		).toBe('char(32) COLLATE "C"');
		expect(
			getTableConfig(boardOperations)
				.columns.find(({ name }) => name === "request_hash")
				?.getSQLType(),
		).toBe('char(64) COLLATE "C"');
	});

	test.skipIf(!realPostgres)("matches the migrated PostgreSQL constraints and collations", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const sql = yield* SqlClient.SqlClient;
				const constraints = yield* sql<{ readonly name: string }>`SELECT conname AS name
					FROM pg_constraint
					WHERE conrelid IN ('boards'::regclass, 'board_operations'::regclass)
					AND contype IN ('c', 'f', 'u')
					ORDER BY conname`;
				expect(constraints.map(({ name }) => name)).toEqual(constraintNames());
				const collations = yield* sql<{ readonly column_name: string; readonly collation_name: string }>`
					SELECT a.attname AS column_name, c.collname AS collation_name
					FROM pg_attribute a
					JOIN pg_class r ON r.oid = a.attrelid
					JOIN pg_collation c ON c.oid = a.attcollation
					WHERE r.relname IN ('boards', 'board_operations')
					AND a.attname IN ('slug', 'request_hash')
					ORDER BY a.attname`;
				expect(collations).toEqual([
					{ column_name: "request_hash", collation_name: "C" },
					{ column_name: "slug", collation_name: "C" },
				]);
			}),
		);
	});
});
