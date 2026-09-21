import { Schema } from "effect";

export const DashboardPhase = Schema.Literals([
	"queued",
	"provisioning",
	"ready",
	"blocked",
	"deleting",
	"deletion_blocked",
]);
export type DashboardPhase = typeof DashboardPhase.Type;

// `progress` is an expected condition while a board boots, such as a provider observation that is
// not settled yet. `warning` is a real failure the worker is still retrying, and `error` is a state
// that stopped and needs an operator.
export const DashboardErrorSeverity = Schema.Literals(["progress", "warning", "error"]);
export type DashboardErrorSeverity = typeof DashboardErrorSeverity.Type;

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
	operation: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				id: Schema.String,
				state: Schema.Literals(["queued", "running", "succeeded", "failed"]),
				attempt: Schema.Int,
				updated_at: Schema.String,
				next_attempt_at: Schema.NullOr(Schema.String),
			}),
		),
	),
	created_at: Schema.String,
	last_backup: Schema.NullOr(DashboardBackup),
	error: Schema.NullOr(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			retrying: Schema.Boolean,
			severity: DashboardErrorSeverity,
		}),
	),
});
export type DashboardBoard = typeof DashboardBoard.Type;

export const DashboardBoardsResponse = Schema.Struct({
	boards: Schema.Array(DashboardBoard),
	truncated: Schema.Boolean,
	capabilities: Schema.optional(Schema.Struct({ postgres: Schema.Boolean })),
});
export type DashboardBoardList = typeof DashboardBoardsResponse.Type;

export const DashboardCreateRequest = Schema.Struct({
	name: Schema.String,
	storage_engine: Schema.optional(Schema.Literals(["sqlite", "postgres"])),
	postgres_admin_url: Schema.optional(Schema.String),
});
export type DashboardCreateRequest = typeof DashboardCreateRequest.Type;

export interface CreateDashboardBoard extends DashboardCreateRequest {
	readonly idempotency_key: string;
}

export const DashboardBoardResponse = Schema.Struct({ board: DashboardBoard });

export const DashboardDeleteRequest = Schema.Struct({ confirmation_name: Schema.String });
export const DashboardDeleteResponse = Schema.Union([
	Schema.Struct({ deleted: Schema.Literal(true) }),
	DashboardBoardResponse,
]);
