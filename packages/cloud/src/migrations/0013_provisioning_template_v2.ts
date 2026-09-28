import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 13;
export const name = "provisioning_template_v2";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];
export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`WITH upgraded AS (
			UPDATE board_deployments AS deployment
			SET volume_name = 'chirp_data',
				row_version = deployment.row_version + 1,
				updated_at = clock_timestamp()
			FROM boards AS board
			WHERE deployment.board_id = board.id
				AND deployment.volume_id IS NULL
				AND deployment.machine_id IS NULL
				AND deployment.volume_name = 'chirp_data_' || board.slug
				AND NOT EXISTS (
					SELECT 1 FROM board_operations AS operation
					WHERE operation.board_id = deployment.board_id
						AND operation.kind = 'provision'
						AND 'volume_create' = ANY(operation.ambiguous_mutations)
				)
			RETURNING deployment.board_id
		)
		UPDATE board_operations
		SET ambiguous_mutations = array_remove(ambiguous_mutations, 'volume_create'),
			updated_at = clock_timestamp()
		WHERE kind = 'provision' AND board_id IN (SELECT board_id FROM upgraded)`);
	});
