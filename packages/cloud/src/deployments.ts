import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	Deployment,
	DeploymentDrift,
	DeploymentFenceLost,
	type DeploymentSpec,
	type DeploymentState,
	InvalidDeploymentTransition,
} from "./deployment.ts";

const deployments = Schema.decodeUnknownEffect(Schema.Array(Deployment));
const leaseRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ board_id: Schema.String, desired_revision: Schema.Int, checkpoint: Schema.String })),
);
const boardRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ slug: Schema.String, storage_engine: Schema.String })),
);
const routeRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ board_id: Schema.String, app_name: Schema.String })),
);
const nextState: Readonly<Partial<Record<DeploymentState, DeploymentState>>> = {
	requested: "storage_configuration_verified",
	storage_configuration_verified: "app_created",
	app_created: "volume_created",
	volume_created: "runtime_secrets_written",
	runtime_secrets_written: "machine_created",
	machine_created: "machine_started",
	machine_started: "edge_reachable",
	edge_reachable: "child_route_observed",
	child_route_observed: "provisioned",
};

export interface DeploymentLease {
	readonly operationId: string;
	readonly leaseToken: string;
	readonly workerId: string;
}

export interface DeploymentTransition extends DeploymentLease {
	readonly expectedCheckpoint: DeploymentState;
	readonly expectedRowVersion: number;
	readonly next: DeploymentState;
	readonly appId?: string;
	readonly volumeId?: string;
	readonly machineId?: string;
	readonly machineVersion?: string;
	readonly secretsVersion?: number;
}

export interface VerifiedSnapshot {
	readonly id: string;
	readonly createdAt: Date;
	readonly digest: string;
	readonly retentionDays: number;
}

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const columns = sql`board_id, provider, state, desired_revision, row_version, hostname, storage_engine,
		region, image_ref, app_name, network_name, volume_name, machine_name, volume_size_gb,
		app_id, volume_id, machine_id, machine_version, secrets_version, last_snapshot_id,
		last_snapshot_created_at::text AS last_snapshot_created_at, last_snapshot_digest,
		last_snapshot_retention_days, created_at::text AS created_at, updated_at::text AS updated_at`;
	const decodeOne = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
		effect.pipe(
			Effect.flatMap(deployments),
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
		);
	const lease = (input: DeploymentLease, kind: "provision" | "backup") =>
		sql`SELECT board_id, desired_revision, checkpoint FROM board_operations
			WHERE id = ${input.operationId} AND state = 'running' AND lease_token = ${input.leaseToken}
				AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp() AND kind = ${kind}
			FOR UPDATE`.pipe(
			Effect.flatMap(leaseRows),
			Effect.flatMap((rows) =>
				rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new DeploymentFenceLost({ operationId: input.operationId })),
			),
		);
	const assertSpec = (deployment: Deployment, storageEngine: string, spec: DeploymentSpec) => {
		const values: ReadonlyArray<readonly [string, string | number, string | number]> = [
			["storage_engine", deployment.storage_engine, storageEngine],
			["hostname", deployment.hostname, spec.hostname],
			["region", deployment.region, spec.region],
			["image_ref", deployment.image_ref, spec.image_ref],
			["app_name", deployment.app_name, spec.app_name],
			["network_name", deployment.network_name, spec.network_name],
			["volume_name", deployment.volume_name, spec.volume_name],
			["machine_name", deployment.machine_name, spec.machine_name],
			["volume_size_gb", deployment.volume_size_gb, spec.volume_size_gb],
		];
		const changed = values.find(([, actual, expected]) => actual !== expected);
		return changed
			? Effect.fail(new DeploymentDrift({ boardId: deployment.board_id, field: changed[0] }))
			: Effect.succeed(deployment);
	};
	return {
		ensure: (input: DeploymentLease & { readonly spec: DeploymentSpec }) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const board = yield* sql`SELECT slug, storage_engine FROM boards WHERE id = ${locked.board_id}`.pipe(
						Effect.flatMap(boardRows),
						Effect.map((rows) => rows[0]),
					);
					if (!board) return yield* Effect.die("Leased operation references no board");
					yield* sql`INSERT INTO board_deployments (
						board_id, state, desired_revision, hostname, storage_engine, region, image_ref,
						app_name, network_name, volume_name, machine_name, volume_size_gb
					) VALUES (
						${locked.board_id}, 'requested', ${locked.desired_revision}, ${input.spec.hostname},
						${board.storage_engine}, ${input.spec.region}, ${input.spec.image_ref}, ${input.spec.app_name},
						${input.spec.network_name}, ${input.spec.volume_name}, ${input.spec.machine_name},
						${input.spec.volume_size_gb}
					) ON CONFLICT (board_id) DO NOTHING`;
					const found = yield* decodeOne(
						sql`SELECT ${columns} FROM board_deployments WHERE board_id = ${locked.board_id}`,
					);
					if (Option.isNone(found)) return yield* Effect.die("Deployment insert returned no row");
					if (found.value.desired_revision !== locked.desired_revision)
						return yield* new DeploymentDrift({ boardId: locked.board_id, field: "desired_revision" });
					if (found.value.state !== locked.checkpoint)
						return yield* new DeploymentDrift({ boardId: locked.board_id, field: "checkpoint" });
					return yield* assertSpec(found.value, board.storage_engine, input.spec);
				}),
			),
		get: (boardId: string) => decodeOne(sql`SELECT ${columns} FROM board_deployments WHERE board_id = ${boardId}`),
		transition: (input: DeploymentTransition) =>
			Effect.gen(function* () {
				if (nextState[input.expectedCheckpoint] !== input.next)
					return yield* new InvalidDeploymentTransition({ expected: input.expectedCheckpoint, next: input.next });
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const locked = yield* lease(input, "provision");
						const current = yield* decodeOne(sql`SELECT ${columns} FROM board_deployments
						WHERE board_id = ${locked.board_id} AND desired_revision = ${locked.desired_revision}
							AND row_version = ${input.expectedRowVersion} AND state = ${input.expectedCheckpoint}
						FOR UPDATE`);
						if (Option.isNone(current)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						const updated = yield* decodeOne(sql`UPDATE board_deployments SET
						state = ${input.next}, row_version = row_version + 1,
						app_id = COALESCE(${input.appId ?? null}, app_id),
						volume_id = COALESCE(${input.volumeId ?? null}, volume_id),
						machine_id = COALESCE(${input.machineId ?? null}, machine_id),
						machine_version = COALESCE(${input.machineVersion ?? null}, machine_version),
						secrets_version = COALESCE(${input.secretsVersion ?? null}, secrets_version),
						updated_at = clock_timestamp()
					WHERE board_id = ${locked.board_id} AND row_version = ${input.expectedRowVersion}
					RETURNING ${columns}`);
						if (Option.isNone(updated)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						const checkpointed = yield* sql`UPDATE board_operations SET checkpoint = ${input.next},
						updated_at = clock_timestamp()
					WHERE id = ${input.operationId} AND state = 'running' AND lease_token = ${input.leaseToken}
						AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
						AND checkpoint = ${input.expectedCheckpoint} AND desired_revision = ${locked.desired_revision}
					RETURNING id`;
						if (checkpointed.length !== 1) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						return updated.value;
					}),
				);
			}),
		publishRoute: (input: DeploymentLease & { readonly expectedRowVersion: number }) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const deployment = yield* decodeOne(sql`SELECT ${columns} FROM board_deployments
						WHERE board_id = ${locked.board_id} AND desired_revision = ${locked.desired_revision}
							AND row_version = ${input.expectedRowVersion} AND state = 'machine_started'
						FOR UPDATE`);
					if (Option.isNone(deployment)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					yield* sql`INSERT INTO board_routes (hostname, board_id, app_name)
						VALUES (${deployment.value.hostname}, ${deployment.value.board_id}, ${deployment.value.app_name})
						ON CONFLICT (hostname) DO NOTHING`;
					const route = yield* sql`SELECT board_id, app_name FROM board_routes
						WHERE hostname = ${deployment.value.hostname}`.pipe(
						Effect.flatMap(routeRows),
						Effect.map((rows) => rows[0]),
					);
					if (!route || route.board_id !== deployment.value.board_id || route.app_name !== deployment.value.app_name)
						return yield* new DeploymentDrift({ boardId: deployment.value.board_id, field: "route" });
					return deployment.value;
				}),
			),
		recordSnapshot: (
			input: DeploymentLease & {
				readonly expectedRowVersion: number;
				readonly snapshot: VerifiedSnapshot;
			},
		) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const locked = yield* lease(input, "backup");
					const updated = yield* decodeOne(sql`UPDATE board_deployments SET
						last_snapshot_id = ${input.snapshot.id},
						last_snapshot_created_at = ${input.snapshot.createdAt},
						last_snapshot_digest = ${input.snapshot.digest},
						last_snapshot_retention_days = ${input.snapshot.retentionDays},
						row_version = row_version + 1, updated_at = clock_timestamp()
					WHERE board_id = ${locked.board_id} AND desired_revision = ${locked.desired_revision}
						AND row_version = ${input.expectedRowVersion} AND state = 'provisioned'
						AND (last_snapshot_created_at IS NULL OR last_snapshot_created_at <= ${input.snapshot.createdAt})
					RETURNING ${columns}`);
					if (Option.isNone(updated)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					return updated.value;
				}),
			),
		block: (input: DeploymentLease & { readonly errorCode: string; readonly errorMessage: string }) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const deployment = yield* decodeOne(sql`UPDATE board_deployments SET state = 'blocked',
						row_version = row_version + 1, updated_at = clock_timestamp()
					WHERE board_id = ${locked.board_id} AND desired_revision = ${locked.desired_revision}
					RETURNING ${columns}`);
					if (Option.isNone(deployment)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					const failed = yield* sql`UPDATE board_operations SET state = 'failed', lease_token = NULL,
						lease_owner = NULL, lease_expires_at = NULL, last_error_code = ${input.errorCode},
						last_error_message = ${input.errorMessage}, updated_at = clock_timestamp(),
						finished_at = clock_timestamp()
					WHERE id = ${input.operationId} AND state = 'running' AND lease_token = ${input.leaseToken}
						AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
					RETURNING id`;
					if (failed.length !== 1) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					return deployment.value;
				}),
			),
	};
});

export class Deployments extends Context.Service<Deployments, Effect.Success<typeof make>>()(
	"comms/cloud/Deployments",
) {}
export const deploymentsLayer = Layer.effect(Deployments, make);
