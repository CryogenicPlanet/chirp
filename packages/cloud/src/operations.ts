import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { Database, type DatabaseClient } from "./database.ts";
import {
	BoardNotFound,
	type EnqueueOperation,
	IdempotencyConflict,
	InvalidLeaseDuration,
	LeaseLost,
	type Operation,
	OperationAlreadyActive,
} from "./operation.ts";
import { boardOperations, boards } from "./schema.ts";

const encodeRequestHash = Schema.encodeSync(
	Schema.fromJsonString(Schema.Struct({ board_id: Schema.String, owner_id: Schema.String, kind: Schema.String })),
);

const clockTimestamp = () => sql<Date>`clock_timestamp()`;
const leaseExpiry = (milliseconds: number) => sql<Date>`clock_timestamp() + ${milliseconds} * interval '1 millisecond'`;

const make = Effect.gen(function* () {
	const database = yield* Database;
	const crypto = yield* Crypto.Crypto;
	const byRequest = (requestedBy: string, idempotencyKey: string) =>
		database
			.select()
			.from(boardOperations)
			.where(and(eq(boardOperations.requested_by, requestedBy), eq(boardOperations.idempotency_key, idempotencyKey)))
			.limit(1)
			.pipe(Effect.map((found) => Option.fromNullishOr(found[0])));
	const activeForBoard = (boardId: string) =>
		database
			.select()
			.from(boardOperations)
			.where(and(eq(boardOperations.board_id, boardId), inArray(boardOperations.state, ["queued", "running"])))
			.limit(1)
			.pipe(Effect.map((found) => Option.fromNullishOr(found[0])));
	const ownedBoard = (boardId: string, ownerId: string) =>
		database
			.select({ id: boards.id })
			.from(boards)
			.where(and(eq(boards.id, boardId), eq(boards.owner_id, ownerId)))
			.limit(1)
			.pipe(Effect.map((found) => found.length > 0));
	const leased = <E, R>(effect: Effect.Effect<readonly Operation[], E, R>, operationId: string) =>
		effect.pipe(
			Effect.flatMap((found) => {
				const operation = found[0];
				return operation ? Effect.succeed(operation) : new LeaseLost({ operationId });
			}),
		);
	const withLease = <A, E, R>(
		input: { readonly id: string; readonly leaseToken: string; readonly workerId: string },
		effect: (transaction: DatabaseClient) => Effect.Effect<A, E, R>,
	) =>
		database.transaction((transaction) =>
			Effect.gen(function* () {
				const locked = yield* transaction
					.select({ id: boardOperations.id })
					.from(boardOperations)
					.where(
						and(
							eq(boardOperations.id, input.id),
							eq(boardOperations.state, "running"),
							eq(boardOperations.lease_token, input.leaseToken),
							eq(boardOperations.lease_owner, input.workerId),
						),
					)
					.for("update")
					.limit(1);
				if (!locked[0]) return yield* new LeaseLost({ operationId: input.id });
				return yield* effect(transaction);
			}),
		);
	const leaseDuration = (milliseconds: number): Effect.Effect<number, InvalidLeaseDuration> =>
		Number.isSafeInteger(milliseconds) && milliseconds > 0
			? Effect.succeed(milliseconds)
			: Effect.fail(new InvalidLeaseDuration({ milliseconds }));
	return {
		enqueue: (input: EnqueueOperation) =>
			Effect.gen(function* () {
				if (!(yield* ownedBoard(input.board_id, input.owner_id)))
					return yield* new BoardNotFound({ boardId: input.board_id });
				const requestHashBytes = yield* crypto.digest(
					"SHA-256",
					new TextEncoder().encode(
						encodeRequestHash({ board_id: input.board_id, owner_id: input.owner_id, kind: input.kind }),
					),
				);
				let requestHash = "";
				for (const byte of requestHashBytes) requestHash += byte.toString(16).padStart(2, "0");
				const existing = yield* byRequest(input.requested_by, input.idempotency_key);
				if (Option.isSome(existing)) {
					if (existing.value.request_hash !== requestHash)
						return yield* new IdempotencyConflict({
							requestedBy: input.requested_by,
							idempotencyKey: input.idempotency_key,
						});
					return existing.value;
				}
				const id = yield* crypto.randomUUIDv7;
				const insert = database.transaction((transaction) =>
					transaction
						.insert(boardOperations)
						.values({
							id,
							board_id: input.board_id,
							kind: input.kind,
							state: "queued",
							checkpoint: "requested",
							requested_by: input.requested_by,
							idempotency_key: input.idempotency_key,
							request_hash: requestHash,
						})
						.returning()
						.pipe(
							Effect.flatMap((created) => {
								const operation = created[0];
								return operation ? Effect.succeed(operation) : Effect.die("Operation insert returned no row");
							}),
						),
				);
				return yield* insert.pipe(
					Effect.catchTag("EffectDrizzleQueryError", (error) =>
						Effect.gen(function* () {
							const sameRequest = yield* byRequest(input.requested_by, input.idempotency_key);
							if (Option.isSome(sameRequest)) {
								if (sameRequest.value.request_hash !== requestHash)
									return yield* new IdempotencyConflict({
										requestedBy: input.requested_by,
										idempotencyKey: input.idempotency_key,
									});
								return sameRequest.value;
							}
							if (Option.isSome(yield* activeForBoard(input.board_id)))
								return yield* new OperationAlreadyActive({ boardId: input.board_id });
							return yield* error;
						}),
					),
				);
			}),
		claim: (workerId: string, leaseMilliseconds: number) =>
			leaseDuration(leaseMilliseconds).pipe(
				Effect.flatMap((duration) =>
					crypto.randomUUIDv7.pipe(Effect.map((leaseToken) => [duration, leaseToken] as const)),
				),
				Effect.flatMap(([duration, leaseToken]) => {
					const candidate = database.$with("candidate").as(
						database
							.select({ id: boardOperations.id })
							.from(boardOperations)
							.where(
								or(
									and(eq(boardOperations.state, "queued"), lte(boardOperations.available_at, clockTimestamp())),
									and(eq(boardOperations.state, "running"), lte(boardOperations.lease_expires_at, clockTimestamp())),
								),
							)
							.orderBy(asc(boardOperations.available_at), asc(boardOperations.created_at), asc(boardOperations.id))
							.for("update", { skipLocked: true })
							.limit(1),
					);
					return database
						.with(candidate)
						.update(boardOperations)
						.set({
							state: "running",
							lease_token: leaseToken,
							lease_owner: workerId,
							lease_expires_at: leaseExpiry(duration),
							attempt: sql`${boardOperations.attempt} + 1`,
							updated_at: clockTimestamp(),
						})
						.from(candidate)
						.where(eq(boardOperations.id, candidate.id))
						.returning()
						.pipe(Effect.map((claimed) => Option.fromNullishOr(claimed[0])));
				}),
			),
		renew: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly leaseMilliseconds: number;
		}) =>
			leaseDuration(input.leaseMilliseconds).pipe(
				Effect.flatMap((duration) =>
					withLease(input, (transaction) =>
						leased(
							transaction
								.update(boardOperations)
								.set({ lease_expires_at: leaseExpiry(duration), updated_at: clockTimestamp() })
								.where(
									and(
										eq(boardOperations.id, input.id),
										eq(boardOperations.state, "running"),
										eq(boardOperations.lease_token, input.leaseToken),
										eq(boardOperations.lease_owner, input.workerId),
										gt(boardOperations.lease_expires_at, clockTimestamp()),
									),
								)
								.returning(),
							input.id,
						),
					),
				),
			),
		checkpoint: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly expected: string;
			readonly next: string;
		}) =>
			withLease(input, (transaction) =>
				leased(
					transaction
						.update(boardOperations)
						.set({ checkpoint: input.next, updated_at: clockTimestamp() })
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, clockTimestamp()),
								eq(boardOperations.checkpoint, input.expected),
							),
						)
						.returning(),
					input.id,
				),
			),
		requeue: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly availableAt: Date;
			readonly errorCode: string;
			readonly errorMessage: string;
		}) =>
			withLease(input, (transaction) =>
				leased(
					transaction
						.update(boardOperations)
						.set({
							state: "queued",
							available_at: input.availableAt,
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: input.errorCode,
							last_error_message: input.errorMessage,
							updated_at: clockTimestamp(),
						})
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, clockTimestamp()),
							),
						)
						.returning(),
					input.id,
				),
			),
		succeed: (id: string, leaseToken: string, workerId: string) =>
			withLease({ id, leaseToken, workerId }, (transaction) =>
				leased(
					transaction
						.update(boardOperations)
						.set({
							state: "succeeded",
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: null,
							last_error_message: null,
							updated_at: clockTimestamp(),
							finished_at: clockTimestamp(),
						})
						.where(
							and(
								eq(boardOperations.id, id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, leaseToken),
								eq(boardOperations.lease_owner, workerId),
								gt(boardOperations.lease_expires_at, clockTimestamp()),
							),
						)
						.returning(),
					id,
				),
			),
		fail: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly errorCode: string;
			readonly errorMessage: string;
		}) =>
			withLease(input, (transaction) =>
				leased(
					transaction
						.update(boardOperations)
						.set({
							state: "failed",
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: input.errorCode,
							last_error_message: input.errorMessage,
							updated_at: clockTimestamp(),
							finished_at: clockTimestamp(),
						})
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, clockTimestamp()),
							),
						)
						.returning(),
					input.id,
				),
			),
	};
});

export class Operations extends Context.Service<Operations, Effect.Success<typeof make>>()("comms/cloud/Operations") {}
export const operationsLayer = Layer.effect(Operations, make);
