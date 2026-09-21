import { Data, Schema } from "effect";

export const OperationKind = Schema.Literals(["provision", "backup"]);
export type OperationKind = typeof OperationKind.Type;

const OperationState = Schema.Literals(["queued", "running", "succeeded", "failed"]);

export const ProviderMutation = Schema.Literals([
	"app_create",
	"volume_create",
	"machine_create",
	"machine_start",
	"edge_ip",
	"edge_certificate",
	"edge_a_record",
	"edge_txt_record",
]);
export type ProviderMutation = typeof ProviderMutation.Type;

export const Operation = Schema.Struct({
	id: Schema.String,
	board_id: Schema.String,
	kind: OperationKind,
	state: OperationState,
	checkpoint: Schema.String,
	requested_by: Schema.String,
	idempotency_key: Schema.String,
	request_hash: Schema.String,
	available_at: Schema.DateFromString,
	attempt: Schema.Int,
	failure_count: Schema.Int,
	lease_token: Schema.NullOr(Schema.String),
	lease_owner: Schema.NullOr(Schema.String),
	lease_expires_at: Schema.NullOr(Schema.DateFromString),
	last_error_code: Schema.NullOr(Schema.String),
	last_error_message: Schema.NullOr(Schema.String),
	ambiguous_mutations: Schema.Array(ProviderMutation),
	created_at: Schema.DateFromString,
	updated_at: Schema.DateFromString,
	finished_at: Schema.NullOr(Schema.DateFromString),
});
export type Operation = typeof Operation.Type;

export const EnqueueOperation = Schema.Struct({
	board_id: Schema.String,
	owner_id: Schema.String,
	kind: OperationKind,
	requested_by: Schema.String,
	idempotency_key: Schema.String,
});
export type EnqueueOperation = typeof EnqueueOperation.Type;

export class IdempotencyConflict extends Data.TaggedError("IdempotencyConflict")<{
	readonly requestedBy: string;
	readonly idempotencyKey: string;
}> {}

export class OperationAlreadyActive extends Data.TaggedError("OperationAlreadyActive")<{
	readonly boardId: string;
}> {}

export class DeploymentRetryRequired extends Data.TaggedError("DeploymentRetryRequired")<{
	readonly boardId: string;
}> {}

export class BoardNotFound extends Data.TaggedError("BoardNotFound")<{
	readonly boardId: string;
}> {}

export class LeaseLost extends Data.TaggedError("LeaseLost")<{
	readonly operationId: string;
}> {}

export class InvalidLeaseDuration extends Data.TaggedError("InvalidLeaseDuration")<{
	readonly milliseconds: number;
}> {}
