import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 5;
export const name = "provider_mutation_markers";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE board_operations
			ADD COLUMN ambiguous_mutations TEXT[] NOT NULL DEFAULT '{}'::text[]`);
		yield* database.execute(sql`UPDATE board_operations
			SET ambiguous_mutations = CASE last_error_code
				WHEN 'app_create_ambiguous' THEN ARRAY['app_create']::text[]
				WHEN 'volume_create_ambiguous' THEN ARRAY['volume_create']::text[]
				WHEN 'machine_create_ambiguous' THEN ARRAY['machine_create']::text[]
				WHEN 'machine_start_ambiguous' THEN ARRAY['machine_start']::text[]
				WHEN 'edge_ip_ambiguous' THEN ARRAY['edge_ip']::text[]
				WHEN 'edge_certificate_ambiguous' THEN ARRAY['edge_certificate']::text[]
				WHEN 'edge_a_record_ambiguous' THEN ARRAY['edge_a_record']::text[]
				WHEN 'edge_txt_record_ambiguous' THEN ARRAY['edge_txt_record']::text[]
				ELSE CASE checkpoint
					WHEN 'storage_configuration_verified' THEN ARRAY['app_create']::text[]
					WHEN 'app_created' THEN ARRAY['volume_create']::text[]
					WHEN 'volume_created' THEN ARRAY['machine_create']::text[]
					WHEN 'machine_created' THEN ARRAY['machine_start']::text[]
					WHEN 'machine_started' THEN ARRAY[
						'machine_start', 'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
					]::text[]
					WHEN 'edge_reachable' THEN ARRAY[
						'machine_start', 'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
					]::text[]
					WHEN 'child_route_observed' THEN ARRAY[
						'machine_start', 'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
					]::text[]
					WHEN 'provisioned' THEN ARRAY[
						'machine_start', 'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
					]::text[]
				END
			END
			WHERE kind = 'provision'
				AND (
					state = 'running'
					OR last_error_code IN (
						'app_create_ambiguous', 'volume_create_ambiguous', 'machine_create_ambiguous',
						'machine_start_ambiguous', 'edge_ip_ambiguous', 'edge_certificate_ambiguous',
						'edge_a_record_ambiguous', 'edge_txt_record_ambiguous', 'provider_ambiguous',
						'provider_unavailable', 'provider_observation_pending', 'provider_rejected', 'retry_exhausted'
					)
				)
				AND checkpoint IN (
					'storage_configuration_verified', 'app_created', 'volume_created', 'machine_created',
					'machine_started', 'edge_reachable', 'child_route_observed', 'provisioned'
				)`);
		yield* database.execute(sql`UPDATE board_operations AS retry
			SET ambiguous_mutations = retry.ambiguous_mutations || failed.ambiguous_mutations
			FROM board_operations AS failed
			WHERE retry.requested_by = 'operator:deployment-retry'
				AND retry.idempotency_key = failed.id::text
				AND failed.kind = 'provision'
				AND cardinality(failed.ambiguous_mutations) > 0`);
		yield* database.execute(sql`ALTER TABLE board_operations
			ADD CONSTRAINT board_operations_ambiguous_mutations_known CHECK (
				array_position(ambiguous_mutations, NULL) IS NULL
				AND ambiguous_mutations <@ ARRAY[
					'app_create', 'volume_create', 'machine_create', 'machine_start',
					'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
				]::text[]
			)`);
	});
