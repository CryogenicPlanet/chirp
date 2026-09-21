import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../database.ts";

export const id = 11;
export const name = "generic_invitations";
// Older auth instances require an email match and cannot redeem generic links.
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	database.execute(sql`ALTER TABLE cloud_invitations ALTER COLUMN email DROP NOT NULL`);
