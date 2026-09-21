import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 14;
export const name = "board_postgres_secret_stages";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE board_postgres_secrets RENAME COLUMN ciphertext TO bootstrap_ciphertext`);
		yield* database.execute(sql`ALTER TABLE board_postgres_secrets ALTER COLUMN bootstrap_ciphertext DROP NOT NULL`);
		yield* database.execute(sql`ALTER TABLE board_postgres_secrets ADD COLUMN runtime_ciphertext TEXT`);
		yield* database.execute(sql`ALTER TABLE board_postgres_secrets ADD CONSTRAINT board_postgres_secrets_stage_check CHECK (
			(NOT prepared AND bootstrap_ciphertext IS NOT NULL AND runtime_ciphertext IS NULL)
			OR (prepared AND bootstrap_ciphertext IS NULL AND runtime_ciphertext IS NOT NULL)
			OR (prepared AND bootstrap_ciphertext IS NOT NULL AND runtime_ciphertext IS NULL)
		)`);
	});
