import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export const id = 1;
export const name = "foundation";

export const effect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`CREATE TABLE boards (
		id UUID PRIMARY KEY,
		owner_id TEXT NOT NULL,
		name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
		slug CHAR(32) COLLATE "C" NOT NULL UNIQUE CHECK (slug ~ '^[0-9a-f]{32}$'),
		storage_engine TEXT NOT NULL CHECK (storage_engine IN ('sqlite', 'postgres', 'mysql')),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`;
	yield* sql`CREATE INDEX boards_owner_created ON boards (owner_id, created_at DESC, id DESC)`;
	yield* sql`CREATE TABLE board_operations (
		id UUID PRIMARY KEY,
		board_id UUID NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
		kind TEXT NOT NULL CHECK (kind IN ('provision', 'start', 'stop', 'restart', 'backup')),
		state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
		checkpoint TEXT NOT NULL DEFAULT 'requested',
		requested_by TEXT NOT NULL,
		idempotency_key TEXT NOT NULL,
		request_hash CHAR(64) COLLATE "C" NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
		available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
		lease_token UUID,
		lease_owner TEXT,
		lease_expires_at TIMESTAMPTZ,
		last_error_code VARCHAR(64),
		last_error_message VARCHAR(2000),
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		finished_at TIMESTAMPTZ,
		UNIQUE (requested_by, idempotency_key),
		CHECK (
			(state = 'running' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
			OR (state <> 'running' AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
		),
		CHECK (
			(state IN ('succeeded', 'failed') AND finished_at IS NOT NULL)
			OR (state IN ('queued', 'running') AND finished_at IS NULL)
		)
	)`;
	yield* sql`CREATE UNIQUE INDEX board_operations_active_board ON board_operations (board_id) WHERE state IN ('queued', 'running')`;
	yield* sql`CREATE INDEX board_operations_queue ON board_operations (state, available_at, created_at, id)`;
});
