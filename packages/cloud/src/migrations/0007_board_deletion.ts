import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 7;
export const name = "board_deletion";
// Older workers must stop before migration: they do not understand tombstones.
export const compatibleSchemaVersions: ReadonlyArray<number> = [];
export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE boards
			ADD COLUMN deletion_requested_at TIMESTAMPTZ,
			ADD COLUMN deleted_at TIMESTAMPTZ`);
		yield* database.execute(sql`ALTER TABLE board_operations DROP CONSTRAINT board_operations_kind_check`);
		yield* database.execute(sql`ALTER TABLE board_operations ADD CONSTRAINT board_operations_kind_check
			CHECK (kind IN ('provision', 'start', 'stop', 'restart', 'backup', 'delete'))`);
	});
