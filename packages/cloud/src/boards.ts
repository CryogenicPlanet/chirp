import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import type { Board, RequestBoard } from "./board.ts";
import { Database } from "./database.ts";
import { IdempotencyConflict } from "./operation.ts";
import { boardOperations, boards } from "./schema.ts";

const encodeRequestHash = Schema.encodeSync(
	Schema.fromJsonString(Schema.Struct({ owner_id: Schema.String, name: Schema.String, storage_engine: Schema.String })),
);

const hex = (bytes: Uint8Array) => {
	let encoded = "";
	for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
	return encoded;
};

const make = Effect.gen(function* () {
	const database = yield* Database;
	const crypto = yield* Crypto.Crypto;
	const findRequest = (requestedBy: string, idempotencyKey: string) =>
		database
			.select({ ...getTableColumns(boards), request_hash: boardOperations.request_hash })
			.from(boardOperations)
			.innerJoin(boards, eq(boards.id, boardOperations.board_id))
			.where(and(eq(boardOperations.requested_by, requestedBy), eq(boardOperations.idempotency_key, idempotencyKey)))
			.limit(1)
			.pipe(Effect.map((found) => Option.fromNullishOr(found[0])));
	const resolveRequest = (input: RequestBoard, requestHash: string) =>
		findRequest(input.requested_by, input.idempotency_key).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeed(Option.none<Board>()),
					onSome: (found) => {
						if (found.request_hash !== requestHash)
							return new IdempotencyConflict({
								requestedBy: input.requested_by,
								idempotencyKey: input.idempotency_key,
							});
						const { request_hash: _, ...board } = found;
						return Effect.succeedSome(board);
					},
				}),
			),
		);
	return {
		request: (input: RequestBoard) =>
			Effect.gen(function* () {
				const requestHash = hex(
					yield* crypto.digest(
						"SHA-256",
						new TextEncoder().encode(
							encodeRequestHash({
								owner_id: input.owner_id,
								name: input.name,
								storage_engine: input.storage_engine,
							}),
						),
					),
				);
				const existing = yield* resolveRequest(input, requestHash);
				if (Option.isSome(existing)) return existing.value;
				const [id, operationId, slugBytes] = yield* Effect.all([
					crypto.randomUUIDv7,
					crypto.randomUUIDv7,
					crypto.randomBytes(16),
				]);
				const create = database.transaction((transaction) =>
					Effect.gen(function* () {
						const created = yield* transaction
							.insert(boards)
							.values({
								id,
								owner_id: input.owner_id,
								name: input.name,
								slug: hex(slugBytes),
								storage_engine: input.storage_engine,
							})
							.returning();
						const board = created[0];
						if (!board) return yield* Effect.die("Board insert returned no row");
						yield* transaction.insert(boardOperations).values({
							id: operationId,
							board_id: id,
							kind: "provision",
							state: "queued",
							checkpoint: "requested",
							requested_by: input.requested_by,
							idempotency_key: input.idempotency_key,
							request_hash: requestHash,
						});
						return board;
					}),
				);
				return yield* create.pipe(
					Effect.catchTag("EffectDrizzleQueryError", (error) =>
						resolveRequest(input, requestHash).pipe(
							Effect.flatMap(Option.match({ onNone: () => Effect.fail(error), onSome: Effect.succeed })),
						),
					),
				);
			}),
		get: (ownerId: string, id: string) =>
			database
				.select()
				.from(boards)
				.where(and(eq(boards.owner_id, ownerId), eq(boards.id, id)))
				.limit(1)
				.pipe(Effect.map((found) => Option.fromNullishOr(found[0]))),
		getById: (id: string) =>
			database
				.select()
				.from(boards)
				.where(eq(boards.id, id))
				.limit(1)
				.pipe(Effect.map((found) => Option.fromNullishOr(found[0]))),
		list: (ownerId: string) =>
			database
				.select()
				.from(boards)
				.where(eq(boards.owner_id, ownerId))
				.orderBy(desc(boards.created_at), desc(boards.id)),
	};
});

export class Boards extends Context.Service<Boards, Effect.Success<typeof make>>()("comms/cloud/Boards") {}
export const boardsLayer = Layer.effect(Boards, make);
