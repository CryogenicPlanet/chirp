import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Crypto, Data, Effect, Schema } from "effect";
import { Database } from "./database.ts";
import { DeploymentState } from "./deployment.ts";
import { boardDeployments, boardOperations } from "./schema.ts";

export class DeploymentRetryRefused extends Data.TaggedError("DeploymentRetryRefused")<{
	readonly message: string;
}> {}

export const retryBlockedDeployment = (input: {
	readonly failedOperationId: string;
	readonly expectedRowVersion: number;
}) =>
	Effect.gen(function* () {
		const database = yield* Database;
		const crypto = yield* Crypto.Crypto;
		return yield* database.transaction(() =>
			Effect.gen(function* () {
				const failed = (
					yield* database
						.select({
							id: boardOperations.id,
							board_id: boardOperations.board_id,
							kind: boardOperations.kind,
							state: boardOperations.state,
							checkpoint: boardOperations.checkpoint,
							request_hash: boardOperations.request_hash,
						})
						.from(boardOperations)
						.where(eq(boardOperations.id, input.failedOperationId))
						.for("update")
						.limit(1)
				)[0];
				if (!failed || failed.kind !== "provision" || failed.state !== "failed")
					return yield* new DeploymentRetryRefused({ message: "Choose a failed provisioning operation" });
				const existing = (
					yield* database
						.select({ id: boardOperations.id })
						.from(boardOperations)
						.where(
							and(
								eq(boardOperations.requested_by, "operator:deployment-retry"),
								eq(boardOperations.idempotency_key, failed.id),
							),
						)
						.limit(1)
				)[0];
				if (existing) return existing.id;
				const deployment = (
					yield* database
						.select({ state: boardDeployments.state, row_version: boardDeployments.row_version })
						.from(boardDeployments)
						.where(eq(boardDeployments.board_id, failed.board_id))
						.for("update")
						.limit(1)
				)[0];
				if (!deployment || deployment.state !== "blocked" || deployment.row_version !== input.expectedRowVersion)
					return yield* new DeploymentRetryRefused({
						message: "Blocked deployment changed; inspect its current row version",
					});
				if (!Schema.is(DeploymentState)(failed.checkpoint) || failed.checkpoint === "blocked")
					return yield* new DeploymentRetryRefused({ message: "Failed operation has no resumable checkpoint" });
				const conflicting = yield* database
					.select({ id: boardOperations.id })
					.from(boardOperations)
					.where(
						and(
							eq(boardOperations.board_id, failed.board_id),
							or(
								inArray(boardOperations.state, ["queued", "running"]),
								and(
									eq(boardOperations.kind, "provision"),
									sql`(${boardOperations.created_at}, ${boardOperations.id}) > (
										SELECT baseline.created_at, baseline.id
										FROM board_operations AS baseline
										WHERE baseline.id = ${failed.id}
									)`,
								),
							),
						),
					)
					.limit(1);
				if (conflicting.length > 0)
					return yield* new DeploymentRetryRefused({
						message: "The board has active work or a newer provisioning operation",
					});
				const id = yield* crypto.randomUUIDv7;
				yield* database.insert(boardOperations).values({
					id,
					board_id: failed.board_id,
					kind: "provision",
					state: "queued",
					checkpoint: failed.checkpoint,
					requested_by: "operator:deployment-retry",
					idempotency_key: failed.id,
					request_hash: failed.request_hash,
				});
				yield* database
					.update(boardDeployments)
					.set({
						state: failed.checkpoint,
						row_version: sql`${boardDeployments.row_version} + 1`,
						updated_at: sql`clock_timestamp()`,
					})
					.where(eq(boardDeployments.board_id, failed.board_id));
				return id;
			}),
		);
	});
