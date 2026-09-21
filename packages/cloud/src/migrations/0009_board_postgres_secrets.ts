import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../database.ts";

export const id = 9;
export const name = "board_postgres_secrets";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	database.execute(sql`CREATE TABLE board_postgres_secrets (
		board_id UUID PRIMARY KEY REFERENCES boards(id),
		bootstrap_ciphertext TEXT,
		runtime_ciphertext TEXT,
		prepared BOOLEAN NOT NULL DEFAULT false,
		fly_secrets_version INTEGER CHECK (fly_secrets_version > 0),
		CONSTRAINT board_postgres_secrets_stage_check CHECK (
			(NOT prepared AND bootstrap_ciphertext IS NOT NULL AND runtime_ciphertext IS NULL)
			OR (prepared AND bootstrap_ciphertext IS NULL AND runtime_ciphertext IS NOT NULL)
		)
	)`);
