import { and, eq, gt, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import { Database } from "./database.ts";
import { Deployments } from "./deployments.ts";
import { FlyBoardApi } from "./fly-board-api.ts";
import { FlyDeletionApi } from "./fly-deletion-api.ts";
import { LeaseLost, type Operation } from "./operation.ts";
import { Operations } from "./operations.ts";
import { boardOperations, boardPostgresSecrets, boardRoutes, boards } from "./schema.ts";

class DeletionIssue extends Data.TaggedError("DeletionIssue")<{
	readonly code: string;
	readonly message: string;
	readonly retry: boolean;
}> {}
const drift = (message: string) => new DeletionIssue({ code: "deletion_provider_drift", message, retry: false });
const pending = () =>
	new DeletionIssue({ code: "deletion_pending", message: "Waiting for Fly to confirm resource removal", retry: true });

const make = (organization: string) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const deployments = yield* Deployments;
		const operations = yield* Operations;
		const fly = yield* FlyBoardApi;
		const remove = yield* FlyDeletionApi;
		return {
			run: (operation: Operation, workerId: string) =>
				Effect.gen(function* () {
					if (operation.kind !== "delete" || !operation.lease_token)
						return yield* Effect.die("Expected leased delete operation");
					const lease = { id: operation.id, leaseToken: operation.lease_token, workerId };
					const renew = operations.renew({ ...lease, leaseMilliseconds: 90_000 });
					const flow = Effect.gen(function* () {
						const board = (yield* db.select().from(boards).where(eq(boards.id, operation.board_id)).limit(1))[0];
						if (!board?.deletion_requested_at || board.deleted_at) return yield* drift("Board deletion state changed");
						const found = yield* deployments.get(operation.board_id);
						if (Option.isNone(found)) return yield* drift("Deployment metadata is missing");
						const deployment = found.value;
						// Never adopt provider resources while deleting. Recorded IDs and exact board identities are mandatory.
						const observeApp = Effect.gen(function* () {
							const observed = yield* fly.getApp(deployment.app_name);
							if (Option.isSome(observed)) {
								const app = observed.value;
								if (
									!deployment.app_id ||
									app.id !== deployment.app_id ||
									app.name !== `chirp-${board.slug}` ||
									app.name !== deployment.app_name ||
									app.network !== deployment.network_name ||
									app.network !== `chirp-${board.slug}` ||
									app.organization.slug !== organization
								)
									return yield* drift("Fly App identity does not match this board; no resources were adopted");
							}
							return observed;
						});
						const app = yield* observeApp;
						if (Option.isSome(app)) {
							const machines = yield* fly.listMachines(deployment.app_name);
							const volumes = yield* fly.listVolumes(deployment.app_name);
							if (
								machines.some(
									(machine) =>
										machine.id !== deployment.machine_id ||
										machine.name !== deployment.machine_name ||
										machine.region !== deployment.region ||
										machine.config.metadata["chirp.deployment_id"] !== board.id,
								)
							)
								return yield* drift("Fly App contains an untracked or changed Machine; deletion needs operator review");
							if (
								volumes.some(
									(volume) =>
										volume.id !== deployment.volume_id ||
										volume.name !== deployment.volume_name ||
										volume.region !== deployment.region ||
										(volume.attached_machine_id && volume.attached_machine_id !== deployment.machine_id),
								)
							)
								return yield* drift("Fly App contains an untracked or changed Volume; deletion needs operator review");
							if (machines[0]) {
								yield* observeApp;
								yield* renew;
								yield* remove.machine(deployment.app_name, machines[0].id);
								if (Option.isSome(yield* fly.getMachine(deployment.app_name, machines[0].id))) return yield* pending();
							}
							if (volumes[0]) {
								yield* observeApp;
								yield* renew;
								yield* remove.volume(deployment.app_name, volumes[0].id);
								if (Option.isSome(yield* fly.getVolume(deployment.app_name, volumes[0].id))) return yield* pending();
							}
							yield* renew;
							yield* observeApp;
							if (
								(yield* fly.listMachines(deployment.app_name)).length ||
								(yield* fly.listVolumes(deployment.app_name)).length
							)
								return yield* drift("Fly App is not empty; refusing to delete untracked resources");
							yield* renew;
							yield* remove.app(deployment.app_name);
							if (Option.isSome(yield* observeApp)) return yield* pending();
						}
						// Absence is observed before hiding the board. Finish and tombstone share a fenced transaction.
						yield* db.transaction(() =>
							Effect.gen(function* () {
								yield* db.select({ id: boards.id }).from(boards).where(eq(boards.id, operation.board_id)).for("update");
								const locked = yield* db
									.select({ id: boardOperations.id })
									.from(boardOperations)
									.where(
										and(
											eq(boardOperations.id, operation.id),
											eq(boardOperations.state, "running"),
											eq(boardOperations.lease_token, lease.leaseToken),
											eq(boardOperations.lease_owner, workerId),
											gt(boardOperations.lease_expires_at, sql`clock_timestamp()`),
										),
									)
									.for("update")
									.limit(1);
								if (!locked[0]) return yield* new LeaseLost({ operationId: operation.id });
								yield* db
									.update(boards)
									.set({ deleted_at: sql`clock_timestamp()` })
									.where(eq(boards.id, operation.board_id));
								yield* db.delete(boardRoutes).where(eq(boardRoutes.board_id, operation.board_id));
								yield* db.delete(boardPostgresSecrets).where(eq(boardPostgresSecrets.board_id, operation.board_id));
								yield* operations.succeed(operation.id, lease.leaseToken, workerId);
							}),
						);
						return "deleted" as const;
					});
					return yield* flow.pipe(
						Effect.catchTag("FlyApiError", (error) =>
							Effect.fail(
								new DeletionIssue({
									code: "deletion_provider_unavailable",
									message: "Fly could not confirm deletion; resources remain visible until verified",
									retry:
										error.reason !== "status" || error.status === 429 || (error.status !== null && error.status >= 500),
								}),
							),
						),
						Effect.catchTag("DeletionIssue", (error) =>
							Effect.gen(function* () {
								if (error.retry && operation.attempt < 10) {
									const now = yield* DateTime.now;
									yield* operations.requeue({
										...lease,
										availableAt: DateTime.toDateUtc(DateTime.addDuration(now, 60_000)),
										errorCode: error.code,
										errorMessage: error.message,
									});
									return "requeued" as const;
								}
								yield* operations.fail({
									...lease,
									errorCode: error.code,
									errorMessage: `${error.message}. Resolve the issue, then confirm deletion again to retry.`,
								});
								return "blocked" as const;
							}),
						),
					);
				}),
		};
	});
export class BoardDeletionWorker extends Context.Service<
	BoardDeletionWorker,
	Effect.Success<ReturnType<typeof make>>
>()("comms/cloud/BoardDeletionWorker") {}
export const boardDeletionWorkerLayer = (organization: string) => Layer.effect(BoardDeletionWorker, make(organization));
