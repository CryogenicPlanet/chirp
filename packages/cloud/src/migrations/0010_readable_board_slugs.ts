import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 10;
export const name = "readable_board_slugs";
// Older images validate board slugs as 32 hexadecimal characters.
export const compatibleSchemaVersions: ReadonlyArray<number> = [];
export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE boards DROP CONSTRAINT boards_slug_hex`);
		yield* database.execute(
			sql`ALTER TABLE boards ALTER COLUMN slug TYPE VARCHAR(32) COLLATE "C" USING slug::varchar(32)`,
		);
		yield* database.execute(
			sql`ALTER TABLE boards ADD CONSTRAINT boards_slug_dns CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' AND slug !~ '^xn--')`,
		);
	});
