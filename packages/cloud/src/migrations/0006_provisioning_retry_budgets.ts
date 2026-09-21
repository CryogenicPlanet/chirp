import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 6;
export const name = "provisioning_retry_budgets";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE board_operations
			ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`);
		yield* database.execute(sql`ALTER TABLE board_operations
			ADD CONSTRAINT board_operations_failure_count_nonnegative CHECK (failure_count >= 0)`);
	});
