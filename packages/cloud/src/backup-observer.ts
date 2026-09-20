import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import { Deployments, type DeploymentLease, type VerifiedSnapshot } from "./deployments.ts";
import { FlyBoardApi } from "./fly-board-api.ts";
import type { FlyVolumeSnapshot } from "./fly-model.ts";
import type { Operation } from "./operation.ts";
import { Operations } from "./operations.ts";

export class BackupObservationError extends Data.TaggedError("BackupObservationError")<{
	readonly code: "deployment_unavailable" | "snapshot_pending" | "provider_unavailable";
	readonly message: string;
}> {}

const verified = (snapshot: FlyVolumeSnapshot): VerifiedSnapshot | undefined => {
	if (
		snapshot.status !== "created" ||
		!snapshot.id ||
		!snapshot.created_at ||
		!snapshot.digest ||
		snapshot.retention_days === undefined
	)
		return undefined;
	const createdAt = DateTime.make(snapshot.created_at);
	return Option.isNone(createdAt)
		? undefined
		: {
				id: snapshot.id,
				createdAt: DateTime.toDateUtc(createdAt.value),
				digest: snapshot.digest,
				retentionDays: snapshot.retention_days,
			};
};

const make = Effect.gen(function* () {
	const deployments = yield* Deployments;
	const operations = yield* Operations;
	const fly = yield* FlyBoardApi;
	return {
		run: (operation: Operation, workerId: string) =>
			Effect.gen(function* () {
				if (operation.kind !== "backup" || !operation.lease_token || operation.lease_owner !== workerId)
					return yield* new BackupObservationError({
						code: "deployment_unavailable",
						message: "Backup observer received an invalid operation",
					});
				const lease: DeploymentLease = {
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId,
				};
				return yield* Effect.gen(function* () {
					yield* operations.renew({
						id: operation.id,
						leaseToken: lease.leaseToken,
						workerId,
						leaseMilliseconds: 90_000,
					});
					const deployment = yield* deployments.get(operation.board_id);
					if (deployment._tag === "None" || deployment.value.state !== "provisioned")
						return yield* new BackupObservationError({
							code: "deployment_unavailable",
							message: "Managed SQLite deployment is not provisioned",
						});
					if (deployment.value.storage_engine !== "sqlite" || !deployment.value.volume_id)
						return yield* new BackupObservationError({
							code: "deployment_unavailable",
							message: "Deployment does not have managed SQLite storage",
						});
					const snapshots = yield* fly.listVolumeSnapshots(deployment.value.app_name, deployment.value.volume_id).pipe(
						Effect.mapError(
							() =>
								new BackupObservationError({
									code: "provider_unavailable",
									message: "Fly snapshot observation failed",
								}),
						),
					);
					const latest = snapshots
						.flatMap((snapshot) => {
							const value = verified(snapshot);
							return value ? [value] : [];
						})
						.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
					if (!latest)
						return yield* new BackupObservationError({
							code: "snapshot_pending",
							message: "No completed Fly Volume snapshot is observable",
						});
					yield* deployments.recordSnapshot({
						...lease,
						expectedRowVersion: deployment.value.row_version,
						snapshot: latest,
					});
					yield* operations.succeed(operation.id, lease.leaseToken, workerId);
					return "succeeded" as const;
				}).pipe(
					Effect.catchTag("BackupObservationError", (error) =>
						Effect.gen(function* () {
							yield* operations.fail({
								id: operation.id,
								leaseToken: lease.leaseToken,
								workerId,
								errorCode: error.code,
								errorMessage: error.message,
							});
							return "failed" as const;
						}),
					),
				);
			}),
	};
});

export class BackupObserver extends Context.Service<BackupObserver, Effect.Success<typeof make>>()(
	"comms/cloud/BackupObserver",
) {}
export const backupObserverLayer = Layer.effect(BackupObserver, make);
