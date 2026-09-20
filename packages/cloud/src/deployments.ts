import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { Database } from "./database.ts";
import {
	type Deployment,
	DeploymentDrift,
	DeploymentFenceLost,
	type DeploymentSpec,
	type DeploymentState,
	InvalidDeploymentTransition,
} from "./deployment.ts";
import type { ProviderMutation } from "./operation.ts";
import { boardDeployments, boardOperations, boardRoutes, boards } from "./schema.ts";

const nextState: Readonly<Partial<Record<DeploymentState, DeploymentState>>> = {
	requested: "storage_configuration_verified",
	storage_configuration_verified: "app_created",
	app_created: "volume_created",
	volume_created: "machine_created",
	machine_created: "machine_started",
	machine_started: "edge_reachable",
	edge_reachable: "child_route_observed",
	child_route_observed: "provisioned",
};
const now = sql<Date>`clock_timestamp()`;

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
	readonly resolvedMutation?: ProviderMutation;
}

export interface VerifiedSnapshot {
	readonly id: string;
	readonly createdAt: Date;
	readonly digest: string;
	readonly retentionDays: number;
}

const make = Effect.gen(function* () {
	const db = yield* Database;
	const one = <A>(rows: ReadonlyArray<A>) => Option.fromNullishOr(rows[0]);
	const lease = (input: DeploymentLease, kind: "provision" | "backup") =>
		db
			.select({
				board_id: boardOperations.board_id,
				checkpoint: boardOperations.checkpoint,
			})
			.from(boardOperations)
			.where(
				and(
					eq(boardOperations.id, input.operationId),
					eq(boardOperations.state, "running"),
					eq(boardOperations.lease_token, input.leaseToken),
					eq(boardOperations.lease_owner, input.workerId),
					gt(boardOperations.lease_expires_at, now),
					eq(boardOperations.kind, kind),
				),
			)
			.for("update")
			.limit(1)
			.pipe(
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
			db.transaction(() =>
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const foundBoards = yield* db
						.select({ slug: boards.slug, storage_engine: boards.storage_engine })
						.from(boards)
						.where(eq(boards.id, locked.board_id))
						.limit(1);
					const board = foundBoards[0];
					if (!board) return yield* Effect.die("Leased operation references no board");
					yield* db
						.insert(boardDeployments)
						.values({
							board_id: locked.board_id,
							state: "requested",
							hostname: input.spec.hostname,
							storage_engine: board.storage_engine,
							region: input.spec.region,
							image_ref: input.spec.image_ref,
							app_name: input.spec.app_name,
							network_name: input.spec.network_name,
							volume_name: input.spec.volume_name,
							machine_name: input.spec.machine_name,
							volume_size_gb: input.spec.volume_size_gb,
						})
						.onConflictDoNothing({ target: boardDeployments.board_id });
					const found = one(
						yield* db.select().from(boardDeployments).where(eq(boardDeployments.board_id, locked.board_id)).limit(1),
					);
					if (Option.isNone(found)) return yield* Effect.die("Deployment insert returned no row");
					if (found.value.state !== locked.checkpoint)
						return yield* new DeploymentDrift({ boardId: locked.board_id, field: "checkpoint" });
					return yield* assertSpec(found.value, board.storage_engine, input.spec);
				}),
			),
		get: (boardId: string) =>
			db.select().from(boardDeployments).where(eq(boardDeployments.board_id, boardId)).limit(1).pipe(Effect.map(one)),
		transition: (input: DeploymentTransition) =>
			Effect.gen(function* () {
				if (nextState[input.expectedCheckpoint] !== input.next)
					return yield* new InvalidDeploymentTransition({ expected: input.expectedCheckpoint, next: input.next });
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const locked = yield* lease(input, "provision");
						const current = one(
							yield* db
								.select()
								.from(boardDeployments)
								.where(
									and(
										eq(boardDeployments.board_id, locked.board_id),
										eq(boardDeployments.row_version, input.expectedRowVersion),
										eq(boardDeployments.state, input.expectedCheckpoint),
									),
								)
								.for("update")
								.limit(1),
						);
						if (Option.isNone(current)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						const updated = one(
							yield* db
								.update(boardDeployments)
								.set({
									state: input.next,
									row_version: sql`${boardDeployments.row_version} + 1`,
									...(input.appId === undefined ? {} : { app_id: input.appId }),
									...(input.volumeId === undefined ? {} : { volume_id: input.volumeId }),
									...(input.machineId === undefined ? {} : { machine_id: input.machineId }),
									updated_at: now,
								})
								.where(
									and(
										eq(boardDeployments.board_id, locked.board_id),
										eq(boardDeployments.row_version, input.expectedRowVersion),
									),
								)
								.returning(),
						);
						if (Option.isNone(updated)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						const checkpointed = yield* db
							.update(boardOperations)
							.set({
								checkpoint: input.next,
								...(input.resolvedMutation === undefined
									? {}
									: {
											ambiguous_mutations: sql`array_remove(${boardOperations.ambiguous_mutations}, ${input.resolvedMutation})`,
										}),
								updated_at: now,
							})
							.where(
								and(
									eq(boardOperations.id, input.operationId),
									eq(boardOperations.state, "running"),
									eq(boardOperations.lease_token, input.leaseToken),
									eq(boardOperations.lease_owner, input.workerId),
									gt(boardOperations.lease_expires_at, now),
									eq(boardOperations.checkpoint, input.expectedCheckpoint),
								),
							)
							.returning({ id: boardOperations.id });
						if (checkpointed.length !== 1) return yield* new DeploymentFenceLost({ operationId: input.operationId });
						return updated.value;
					}),
				);
			}),
		publishRoute: (input: DeploymentLease & { readonly expectedRowVersion: number }) =>
			db.transaction(() =>
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const deployment = one(
						yield* db
							.select()
							.from(boardDeployments)
							.where(
								and(
									eq(boardDeployments.board_id, locked.board_id),
									eq(boardDeployments.row_version, input.expectedRowVersion),
									eq(boardDeployments.state, "machine_started"),
								),
							)
							.for("update")
							.limit(1),
					);
					if (Option.isNone(deployment)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					yield* db
						.insert(boardRoutes)
						.values({
							hostname: deployment.value.hostname,
							board_id: deployment.value.board_id,
							app_name: deployment.value.app_name,
						})
						.onConflictDoNothing({ target: boardRoutes.hostname });
					const routes = yield* db
						.select({ board_id: boardRoutes.board_id, app_name: boardRoutes.app_name })
						.from(boardRoutes)
						.where(eq(boardRoutes.hostname, deployment.value.hostname))
						.limit(1);
					const route = routes[0];
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
			db.transaction(() =>
				Effect.gen(function* () {
					const locked = yield* lease(input, "backup");
					const updated = one(
						yield* db
							.update(boardDeployments)
							.set({
								last_snapshot_id: input.snapshot.id,
								last_snapshot_created_at: input.snapshot.createdAt,
								last_snapshot_digest: input.snapshot.digest,
								last_snapshot_retention_days: input.snapshot.retentionDays,
								row_version: sql`${boardDeployments.row_version} + 1`,
								updated_at: now,
							})
							.where(
								and(
									eq(boardDeployments.board_id, locked.board_id),
									eq(boardDeployments.row_version, input.expectedRowVersion),
									eq(boardDeployments.state, "provisioned"),
									or(
										isNull(boardDeployments.last_snapshot_created_at),
										lte(boardDeployments.last_snapshot_created_at, input.snapshot.createdAt),
									),
								),
							)
							.returning(),
					);
					if (Option.isNone(updated)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					return updated.value;
				}),
			),
		block: (input: DeploymentLease & { readonly errorCode: string; readonly errorMessage: string }) =>
			db.transaction(() =>
				Effect.gen(function* () {
					const locked = yield* lease(input, "provision");
					const deployment = one(
						yield* db
							.update(boardDeployments)
							.set({
								state: "blocked",
								row_version: sql`${boardDeployments.row_version} + 1`,
								updated_at: now,
							})
							.where(eq(boardDeployments.board_id, locked.board_id))
							.returning(),
					);
					if (Option.isNone(deployment)) return yield* new DeploymentFenceLost({ operationId: input.operationId });
					const failed = yield* db
						.update(boardOperations)
						.set({
							state: "failed",
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: input.errorCode,
							last_error_message: input.errorMessage,
							updated_at: now,
							finished_at: now,
						})
						.where(
							and(
								eq(boardOperations.id, input.operationId),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
							),
						)
						.returning({ id: boardOperations.id });
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
