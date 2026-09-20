import { Data, Schema } from "effect";
import { StorageEngine } from "./board.ts";

export const DeploymentState = Schema.Literals([
	"requested",
	"storage_configuration_verified",
	"app_created",
	"volume_created",
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
	"blocked",
]);
export type DeploymentState = typeof DeploymentState.Type;

export const Deployment = Schema.Struct({
	board_id: Schema.String,
	state: DeploymentState,
	row_version: Schema.Int,
	hostname: Schema.String,
	storage_engine: StorageEngine,
	region: Schema.String,
	image_ref: Schema.String,
	app_name: Schema.String,
	network_name: Schema.String,
	volume_name: Schema.String,
	machine_name: Schema.String,
	volume_size_gb: Schema.Int,
	app_id: Schema.NullOr(Schema.String),
	volume_id: Schema.NullOr(Schema.String),
	machine_id: Schema.NullOr(Schema.String),
	last_snapshot_id: Schema.NullOr(Schema.String),
	last_snapshot_created_at: Schema.NullOr(Schema.DateFromString),
	last_snapshot_digest: Schema.NullOr(Schema.String),
	last_snapshot_retention_days: Schema.NullOr(Schema.Int),
	created_at: Schema.DateFromString,
	updated_at: Schema.DateFromString,
});
export type Deployment = typeof Deployment.Type;

export interface DeploymentSpec {
	readonly hostname: string;
	readonly region: string;
	readonly image_ref: string;
	readonly app_name: string;
	readonly network_name: string;
	readonly volume_name: string;
	readonly machine_name: string;
	readonly volume_size_gb: number;
}

export class DeploymentFenceLost extends Data.TaggedError("DeploymentFenceLost")<{
	readonly operationId: string;
}> {}

export class DeploymentDrift extends Data.TaggedError("DeploymentDrift")<{
	readonly boardId: string;
	readonly field: string;
}> {}

export class InvalidDeploymentTransition extends Data.TaggedError("InvalidDeploymentTransition")<{
	readonly expected: DeploymentState;
	readonly next: DeploymentState;
}> {}
