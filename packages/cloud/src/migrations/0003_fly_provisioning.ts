import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";

export const id = 3;
export const name = "fly_provisioning";
export const compatibleSchemaVersions: ReadonlyArray<number> = [1, 2];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`ALTER TABLE board_operations ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 1
			CHECK (desired_revision > 0)`);
		yield* database.execute(sql`CREATE TABLE board_deployments (
			board_id UUID PRIMARY KEY REFERENCES boards(id) ON DELETE RESTRICT,
			state TEXT NOT NULL CHECK (state IN (
				'requested', 'storage_configuration_verified', 'app_created', 'volume_created',
				'runtime_secrets_written', 'machine_created', 'machine_started', 'edge_reachable',
				'child_route_observed', 'provisioned', 'blocked'
			)),
			desired_revision INTEGER NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
			row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
			hostname TEXT COLLATE "C" NOT NULL UNIQUE,
			storage_engine TEXT NOT NULL CHECK (storage_engine IN ('sqlite', 'postgres', 'mysql')),
			region TEXT NOT NULL,
			image_ref TEXT NOT NULL CHECK (image_ref ~ '@sha256:[0-9a-f]{64}$'),
			app_name TEXT COLLATE "C" NOT NULL UNIQUE,
			network_name TEXT COLLATE "C" NOT NULL,
			volume_name TEXT COLLATE "C" NOT NULL,
			machine_name TEXT COLLATE "C" NOT NULL,
			volume_size_gb INTEGER NOT NULL CHECK (volume_size_gb > 0),
			app_id TEXT,
			volume_id TEXT UNIQUE,
			machine_id TEXT UNIQUE,
			secrets_version INTEGER CHECK (secrets_version IS NULL OR secrets_version >= 0),
			last_snapshot_id TEXT,
			last_snapshot_created_at TIMESTAMPTZ,
			last_snapshot_digest TEXT,
			last_snapshot_retention_days INTEGER CHECK (
				last_snapshot_retention_days IS NULL OR last_snapshot_retention_days >= 0
			),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`);
		yield* database.execute(sql`CREATE TABLE board_routes (
			hostname TEXT COLLATE "C" PRIMARY KEY,
			board_id UUID NOT NULL UNIQUE REFERENCES board_deployments(board_id) ON DELETE RESTRICT,
			app_name TEXT COLLATE "C" NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`);
	});
