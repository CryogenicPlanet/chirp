import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 12;
export const name = "board_release_channel";
// Additive and defaulted: an image at schema 11 never reads or writes the column, and every board it
// inserts takes the default, so it keeps working against this schema.
export const compatibleSchemaVersions: ReadonlyArray<number> = [11];
export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE boards ADD COLUMN channel TEXT NOT NULL DEFAULT 'latest'`);
		yield* database.execute(
			sql`ALTER TABLE boards ADD CONSTRAINT boards_channel_check CHECK (channel IN ('latest', 'canary'))`,
		);
	});
