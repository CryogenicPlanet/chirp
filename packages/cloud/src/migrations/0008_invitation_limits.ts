import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 8;
export const name = "invitation_limits";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];
export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`CREATE TABLE cloud_invitation_limits (
		issuer_id TEXT PRIMARY KEY,
		window_start BIGINT NOT NULL,
		count INTEGER NOT NULL CHECK (count > 0 AND count <= 20)
	)`);
	});
