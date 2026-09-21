import { and, desc, eq, sql } from "drizzle-orm";
import { Context, Crypto, Data, Effect, Layer, Schema } from "effect";
import { Database } from "./database.ts";
import { BoardNotFound, IdempotencyConflict, OperationAlreadyActive } from "./operation.ts";
import { boardDeployments, boardOperations, boardPostgresSecrets, boardRoutes, boards } from "./schema.ts";

export class BoardConfirmationMismatch extends Data.TaggedError("BoardConfirmationMismatch")<{}> {}
export class BoardDeletionUnsafe extends Data.TaggedError("BoardDeletionUnsafe")<{}> {}
export interface DeleteBoard {
	readonly confirmation_name: string;
	readonly idempotency_key: string;
}

const encodeRequest = Schema.encodeSync(
	Schema.fromJsonString(
		Schema.Struct({
			board_id: Schema.String,
			owner_id: Schema.String,
			kind: Schema.Literal("delete"),
			confirmation_name: Schema.String,
		}),
	),
);

const make = Effect.gen(function* () {
	const db = yield* Database;
	const crypto = yield* Crypto.Crypto;
	return {
		request: (ownerId: string, boardId: string, input: DeleteBoard) =>
			db.transaction(() =>
				Effect.gen(function* () {
					yield* db.execute(
						sql`SELECT pg_advisory_xact_lock(hashtextextended(${`chirp-cloud-board-quota:${ownerId}`}, 0))`,
					);
					const board = (yield* db
						.select()
						.from(boards)
						.where(and(eq(boards.id, boardId), eq(boards.owner_id, ownerId)))
						.for("update")
						.limit(1))[0];
					if (!board) return yield* new BoardNotFound({ boardId });
					if (input.confirmation_name !== board.name) return yield* new BoardConfirmationMismatch();
					const bytes = yield* crypto.digest(
						"SHA-256",
						new TextEncoder().encode(
							encodeRequest({
								board_id: boardId,
								owner_id: ownerId,
								kind: "delete",
								confirmation_name: input.confirmation_name,
							}),
						),
					);
					let requestHash = "";
					for (const byte of bytes) requestHash += byte.toString(16).padStart(2, "0");
					const replay = (yield* db
						.select()
						.from(boardOperations)
						.where(
							and(
								eq(boardOperations.requested_by, ownerId),
								eq(boardOperations.idempotency_key, input.idempotency_key),
							),
						)
						.limit(1))[0];
					if (replay) {
						if (replay.request_hash !== requestHash || replay.kind !== "delete")
							return yield* new IdempotencyConflict({ requestedBy: ownerId, idempotencyKey: input.idempotency_key });
						return { deleted: board.deleted_at !== null };
					}
					if (board.deleted_at) return yield* new BoardNotFound({ boardId });
					// Lock the same rows as claim before cancelling anything. A claim that wins makes this conflict.
					const history = yield* db
						.select()
						.from(boardOperations)
						.where(eq(boardOperations.board_id, boardId))
						.orderBy(desc(boardOperations.created_at), desc(boardOperations.id))
						.for("update");
					const active = history.filter((operation) => operation.state === "running" || operation.state === "queued");
					if (
						active.some(
							(operation) => operation.state === "running" || operation.attempt > 0 || operation.kind !== "provision",
						)
					)
						return yield* new OperationAlreadyActive({ boardId });
					const provision = history.find((operation) => operation.kind === "provision");
					if (provision?.ambiguous_mutations.length) return yield* new BoardDeletionUnsafe();
					const deployment = (yield* db
						.select()
						.from(boardDeployments)
						.where(eq(boardDeployments.board_id, boardId))
						.limit(1))[0];
					for (const operation of active)
						yield* db
							.update(boardOperations)
							.set({
								state: "failed",
								finished_at: sql`clock_timestamp()`,
								updated_at: sql`clock_timestamp()`,
								last_error_code: "board_deleted",
								last_error_message: "Board creation was cancelled by its owner",
							})
							.where(eq(boardOperations.id, operation.id));
					const deleted = !deployment;
					yield* db
						.update(boards)
						.set({
							deletion_requested_at: sql`clock_timestamp()`,
							...(deleted ? { deleted_at: sql`clock_timestamp()` } : {}),
						})
						.where(eq(boards.id, boardId));
					yield* db.insert(boardOperations).values({
						id: yield* crypto.randomUUIDv7,
						board_id: boardId,
						kind: "delete",
						state: deleted ? "succeeded" : "queued",
						checkpoint: deleted ? "deleted" : "requested",
						requested_by: ownerId,
						idempotency_key: input.idempotency_key,
						request_hash: requestHash,
						...(deleted ? { finished_at: sql`clock_timestamp()` } : {}),
					});
					if (deleted) {
						yield* db.delete(boardRoutes).where(eq(boardRoutes.board_id, boardId));
						yield* db.delete(boardPostgresSecrets).where(eq(boardPostgresSecrets.board_id, boardId));
					}
					return { deleted };
				}),
			),
	};
});

export class BoardDeletion extends Context.Service<BoardDeletion, Effect.Success<typeof make>>()(
	"comms/cloud/BoardDeletion",
) {}
export const boardDeletionLayer = Layer.effect(BoardDeletion, make);
