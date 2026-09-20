import { Schema } from "effect";

export const DashboardPhase = Schema.Literals(["queued", "provisioning", "ready", "blocked"]);
export type DashboardPhase = typeof DashboardPhase.Type;

export const DashboardBackup = Schema.Struct({
	id: Schema.String,
	created_at: Schema.String,
	digest: Schema.String,
	retention_days: Schema.Int,
});

export const DashboardBoard = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	hostname: Schema.NullOr(Schema.String),
	storage_engine: Schema.Literals(["sqlite", "postgres", "mysql"]),
	region: Schema.NullOr(Schema.String),
	volume_size_gb: Schema.NullOr(Schema.Int),
	phase: DashboardPhase,
	checkpoint: Schema.String,
	created_at: Schema.String,
	last_backup: Schema.NullOr(DashboardBackup),
	error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String, retrying: Schema.Boolean })),
});
export type DashboardBoard = typeof DashboardBoard.Type;

export const DashboardBoardsResponse = Schema.Struct({
	boards: Schema.Array(DashboardBoard),
	truncated: Schema.Boolean,
});
export type DashboardBoardList = typeof DashboardBoardsResponse.Type;

export const DashboardCreateRequest = Schema.Struct({
	name: Schema.String,
});
export type DashboardCreateRequest = typeof DashboardCreateRequest.Type;

export interface CreateDashboardBoard extends DashboardCreateRequest {
	readonly idempotency_key: string;
}

export const DashboardBoardResponse = Schema.Struct({ board: DashboardBoard });
