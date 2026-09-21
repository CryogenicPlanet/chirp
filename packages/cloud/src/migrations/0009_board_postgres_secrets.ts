import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../database.ts";

export const id = 9;
export const name = "board_postgres_secrets";
export const compatibleSchemaVersions: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8];

export const effect = (database: DatabaseClient) =>
	database.execute(sql`CREATE TABLE board_postgres_secrets (
		board_id UUID PRIMARY KEY REFERENCES boards(id),
		ciphertext TEXT NOT NULL,
		prepared BOOLEAN NOT NULL DEFAULT false,
		fly_secrets_version INTEGER CHECK (fly_secrets_version > 0)
	)`);
