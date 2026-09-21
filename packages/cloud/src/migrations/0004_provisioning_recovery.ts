import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 4;
export const name = "provisioning_recovery";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`UPDATE board_operations SET checkpoint = 'volume_created'
			WHERE kind = 'provision' AND checkpoint = 'runtime_secrets_written'`);
		yield* database.execute(sql`UPDATE board_deployments SET state = 'volume_created', row_version = row_version + 1
			WHERE state = 'runtime_secrets_written'`);
		yield* database.execute(sql`ALTER TABLE board_deployments DROP CONSTRAINT board_deployments_state_check`);
		yield* database.execute(sql`ALTER TABLE board_deployments ADD CONSTRAINT board_deployments_state_check CHECK (state IN (
			'requested', 'storage_configuration_verified', 'app_created', 'volume_created',
			'machine_created', 'machine_started', 'edge_reachable', 'child_route_observed', 'provisioned', 'blocked'
		))`);
		yield* database.execute(
			sql`ALTER TABLE board_deployments DROP COLUMN secrets_version, DROP COLUMN desired_revision`,
		);
		yield* database.execute(sql`ALTER TABLE board_operations DROP COLUMN desired_revision`);
		yield* database.execute(sql`ALTER TABLE board_operations DROP CONSTRAINT board_operations_kind_check`);
		yield* database.execute(sql`ALTER TABLE board_operations ADD CONSTRAINT board_operations_kind_check
			CHECK (kind IN ('provision', 'backup'))`);
	});
