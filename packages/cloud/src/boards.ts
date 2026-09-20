import { Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Board, type RequestBoard } from "./board.ts";
import { IdempotencyConflict } from "./operation.ts";

const boards = Schema.decodeUnknownEffect(Schema.Array(Board));
const requestRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ ...Board.fields, request_hash: Schema.String })),
);
const encodeRequestHash = Schema.encodeSync(
	Schema.fromJsonString(Schema.Struct({ owner_id: Schema.String, name: Schema.String, storage_engine: Schema.String })),
);

const hex = (bytes: Uint8Array) => {
	let encoded = "";
	for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
	return encoded;
};

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const columns = sql`b.id, b.owner_id, b.name, b.slug, b.storage_engine, b.created_at::text AS created_at`;
	const findRequest = (requestedBy: string, idempotencyKey: string) =>
		sql`SELECT ${columns}, o.request_hash FROM board_operations o
			JOIN boards b ON b.id = o.board_id
			WHERE o.requested_by = ${requestedBy} AND o.idempotency_key = ${idempotencyKey}`.pipe(
			Effect.flatMap(requestRows),
			Effect.map((found) => Option.fromNullishOr(found[0])),
		);
	const resolveRequest = (input: RequestBoard, requestHash: string) =>
		findRequest(input.requested_by, input.idempotency_key).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeed(Option.none<Board>()),
					onSome: (found) =>
						found.request_hash === requestHash
							? Effect.succeedSome(found)
							: new IdempotencyConflict({
									requestedBy: input.requested_by,
									idempotencyKey: input.idempotency_key,
								}),
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
				const create = sql.withTransaction(
					Effect.gen(function* () {
						const created = yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
							VALUES (${id}, ${input.owner_id}, ${input.name}, ${hex(slugBytes)}, ${input.storage_engine})
							RETURNING id, owner_id, name, slug, storage_engine, created_at::text AS created_at`.pipe(
							Effect.flatMap(boards),
						);
						const board = created[0];
						if (!board) return yield* Effect.die("Board insert returned no row");
						yield* sql`INSERT INTO board_operations (
							id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash
						) VALUES (
							${operationId}, ${id}, 'provision', 'queued', 'requested', ${input.requested_by},
							${input.idempotency_key}, ${requestHash}
						)`;
						return board;
					}),
				);
				return yield* create.pipe(
					Effect.catchTag("SqlError", (error) =>
						resolveRequest(input, requestHash).pipe(
							Effect.flatMap(Option.match({ onNone: () => Effect.fail(error), onSome: Effect.succeed })),
						),
					),
				);
			}),
		get: (ownerId: string, id: string) =>
			sql`SELECT ${columns} FROM boards b WHERE b.owner_id = ${ownerId} AND b.id = ${id}`.pipe(
				Effect.flatMap(boards),
				Effect.map((found) => Option.fromNullishOr(found[0])),
			),
		list: (ownerId: string) =>
			sql`SELECT ${columns} FROM boards b WHERE b.owner_id = ${ownerId} ORDER BY b.created_at DESC, b.id DESC`.pipe(
				Effect.flatMap(boards),
			),
	};
});

export class Boards extends Context.Service<Boards, Effect.Success<typeof make>>()("comms/cloud/Boards") {}
export const boardsLayer = Layer.effect(Boards, make);
