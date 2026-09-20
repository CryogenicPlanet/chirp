import { Effect } from "effect";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../database.ts";

export const id = 1;
export const name = "foundation";
export const compatibleSchemaVersions: ReadonlyArray<number> = [];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`CREATE TABLE boards (
		id UUID PRIMARY KEY,
		owner_id TEXT NOT NULL,
		name TEXT NOT NULL CONSTRAINT boards_name_nonempty CHECK (length(btrim(name)) > 0),
		slug CHAR(32) COLLATE "C" NOT NULL
			CONSTRAINT boards_slug_unique UNIQUE
			CONSTRAINT boards_slug_hex CHECK (slug ~ '^[0-9a-f]{32}$'),
		storage_engine TEXT NOT NULL
			CONSTRAINT boards_storage_engine_check CHECK (storage_engine IN ('sqlite', 'postgres', 'mysql')),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`);
		yield* database.execute(sql`CREATE INDEX boards_owner_created ON boards (owner_id, created_at DESC, id DESC)`);
		yield* database.execute(sql`CREATE TABLE board_operations (
		id UUID PRIMARY KEY,
		board_id UUID NOT NULL
			CONSTRAINT board_operations_board_id_boards_id_fk REFERENCES boards(id) ON DELETE RESTRICT,
		kind TEXT NOT NULL
			CONSTRAINT board_operations_kind_check CHECK (kind IN ('provision', 'start', 'stop', 'restart', 'backup')),
		state TEXT NOT NULL
			CONSTRAINT board_operations_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
		checkpoint TEXT NOT NULL DEFAULT 'requested',
		requested_by TEXT NOT NULL,
		idempotency_key TEXT NOT NULL,
		request_hash CHAR(64) COLLATE "C" NOT NULL
			CONSTRAINT board_operations_request_hash_hex CHECK (request_hash ~ '^[0-9a-f]{64}$'),
		available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		attempt INTEGER NOT NULL DEFAULT 0
			CONSTRAINT board_operations_attempt_nonnegative CHECK (attempt >= 0),
		lease_token UUID,
		lease_owner TEXT,
		lease_expires_at TIMESTAMPTZ,
		last_error_code VARCHAR(64),
		last_error_message VARCHAR(2000),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		finished_at TIMESTAMPTZ,
		CONSTRAINT board_operations_request_unique UNIQUE (requested_by, idempotency_key),
		CONSTRAINT board_operations_lease_shape CHECK (
			(state = 'running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
			OR (state <> 'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
		),
		CONSTRAINT board_operations_finished_shape CHECK (
			(state IN ('succeeded', 'failed') AND finished_at IS NOT NULL)
			OR (state IN ('queued', 'running') AND finished_at IS NULL)
		)
	)`);
		yield* database.execute(
			sql`CREATE UNIQUE INDEX board_operations_active_board ON board_operations (board_id) WHERE state IN ('queued', 'running')`,
		);
		yield* database.execute(
			sql`CREATE INDEX board_operations_queue ON board_operations (state, available_at, created_at, id)`,
		);
	});
