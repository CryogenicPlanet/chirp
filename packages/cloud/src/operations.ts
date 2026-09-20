import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { Database } from "./database.ts";
import {
	BoardNotFound,
	type EnqueueOperation,
	DeploymentRetryRequired,
	IdempotencyConflict,
	InvalidLeaseDuration,
	LeaseLost,
	OperationAlreadyActive,
	type OperationKind,
	type ProviderMutation,
} from "./operation.ts";
import { boardOperations, boards } from "./schema.ts";

const encodeRequestHash = Schema.encodeSync(
	Schema.fromJsonString(Schema.Struct({ board_id: Schema.String, owner_id: Schema.String, kind: Schema.String })),
);
const now = sql<Date>`clock_timestamp()`;

const make = Effect.gen(function* () {
	const db = yield* Database;
	const crypto = yield* Crypto.Crypto;
	const byRequest = (requestedBy: string, idempotencyKey: string) =>
		db
			.select()
			.from(boardOperations)
			.where(and(eq(boardOperations.requested_by, requestedBy), eq(boardOperations.idempotency_key, idempotencyKey)))
			.limit(1)
			.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
	const activeForBoard = (boardId: string) =>
		db
			.select()
			.from(boardOperations)
			.where(and(eq(boardOperations.board_id, boardId), inArray(boardOperations.state, ["queued", "running"])))
			.limit(1)
			.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
	const ownedBoard = (boardId: string, ownerId: string) =>
		db
			.select({ id: boards.id })
			.from(boards)
			.where(and(eq(boards.id, boardId), eq(boards.owner_id, ownerId)))
			.limit(1)
			.pipe(Effect.map((rows) => rows.length === 1));
	const leased = <E, R>(
		effect: Effect.Effect<ReadonlyArray<typeof boardOperations.$inferSelect>, E, R>,
		operationId: string,
	) =>
		effect.pipe(
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
			Effect.flatMap(
				Option.match({
					onNone: () => new LeaseLost({ operationId }),
					onSome: Effect.succeed,
				}),
			),
		);
	const withLease = <A, E, R>(
		input: { readonly id: string; readonly leaseToken: string; readonly workerId: string },
		effect: Effect.Effect<A, E, R>,
	) =>
		db.transaction(() =>
			Effect.gen(function* () {
				const locked = yield* db
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
				return yield* effect;
			}),
		);
	const leaseDuration = (milliseconds: number): Effect.Effect<number, InvalidLeaseDuration> =>
		Number.isSafeInteger(milliseconds) && milliseconds > 0
			? Effect.succeed(milliseconds)
			: Effect.fail(new InvalidLeaseDuration({ milliseconds }));
	return {
		latest: (boardId: string, kind: OperationKind) =>
			decodeOne(sql`SELECT ${columns} FROM board_operations
				WHERE board_id = ${boardId} AND kind = ${kind}
				ORDER BY created_at DESC, id DESC LIMIT 1`),
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
				if (input.kind === "provision") return yield* new DeploymentRetryRequired({ boardId: input.board_id });
				const id = yield* crypto.randomUUIDv7;
				const insert = db.transaction(() =>
					db
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
							Effect.flatMap((rows) =>
								rows[0] ? Effect.succeed(rows[0]) : Effect.die("Operation insert returned no row"),
							),
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
		claim: (workerId: string, leaseMilliseconds: number, kind?: OperationKind) =>
			leaseDuration(leaseMilliseconds).pipe(
				Effect.flatMap((duration) =>
					crypto.randomUUIDv7.pipe(Effect.map((leaseToken) => [duration, leaseToken] as const)),
				),
				Effect.flatMap(([duration, leaseToken]) =>
					db.transaction(() =>
						Effect.gen(function* () {
							const candidate = yield* db
								.select({ id: boardOperations.id })
								.from(boardOperations)
								.where(
									and(
										kind ? eq(boardOperations.kind, kind) : undefined,
										or(
											and(eq(boardOperations.state, "queued"), lte(boardOperations.available_at, now)),
											and(eq(boardOperations.state, "running"), lte(boardOperations.lease_expires_at, now)),
										),
									),
								)
								.orderBy(asc(boardOperations.available_at), asc(boardOperations.created_at), asc(boardOperations.id))
								.for("update", { skipLocked: true })
								.limit(1);
							if (!candidate[0]) return Option.none();
							const claimed = yield* db
								.update(boardOperations)
								.set({
									state: "running",
									lease_token: leaseToken,
									lease_owner: workerId,
									lease_expires_at: sql`clock_timestamp() + ${duration} * interval '1 millisecond'`,
									attempt: sql`${boardOperations.attempt} + 1`,
									updated_at: now,
								})
								.where(eq(boardOperations.id, candidate[0].id))
								.returning();
							return Option.fromNullishOr(claimed[0]);
						}),
					),
				),
			),
		renew: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly leaseMilliseconds: number;
		}) =>
			leaseDuration(input.leaseMilliseconds).pipe(
				Effect.flatMap((duration) =>
					withLease(
						input,
						leased(
							db
								.update(boardOperations)
								.set({
									lease_expires_at: sql`clock_timestamp() + ${duration} * interval '1 millisecond'`,
									updated_at: now,
								})
								.where(
									and(
										eq(boardOperations.id, input.id),
										eq(boardOperations.state, "running"),
										eq(boardOperations.lease_token, input.leaseToken),
										eq(boardOperations.lease_owner, input.workerId),
										gt(boardOperations.lease_expires_at, now),
									),
								)
								.returning(),
							input.id,
						),
					),
				),
			),
		markAmbiguousMutation: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly mutation: ProviderMutation;
		}) =>
			withLease(
				input,
				leased(
					db
						.update(boardOperations)
						.set({
							ambiguous_mutations: sql`CASE
								WHEN ${input.mutation} = ANY(${boardOperations.ambiguous_mutations})
								THEN ${boardOperations.ambiguous_mutations}
								ELSE array_append(${boardOperations.ambiguous_mutations}, ${input.mutation})
							END`,
							updated_at: now,
						})
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
							),
						)
						.returning(),
					input.id,
				),
			),
		clearAmbiguousMutation: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly mutation: ProviderMutation;
		}) =>
			withLease(
				input,
				leased(
					db
						.update(boardOperations)
						.set({
							ambiguous_mutations: sql`array_remove(${boardOperations.ambiguous_mutations}, ${input.mutation})`,
							updated_at: now,
						})
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
							),
						)
						.returning(),
					input.id,
				),
			),
		checkpoint: (input: {
			readonly id: string;
			readonly leaseToken: string;
			readonly workerId: string;
			readonly expected: string;
			readonly next: string;
		}) =>
			withLease(
				input,
				leased(
					db
						.update(boardOperations)
						.set({ checkpoint: input.next, updated_at: now })
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
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
			readonly countFailure?: boolean;
		}) =>
			withLease(
				input,
				leased(
					db
						.update(boardOperations)
						.set({
							state: "queued",
							available_at: input.availableAt,
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: input.errorCode,
							last_error_message: input.errorMessage,
							...(input.countFailure ? { failure_count: sql`${boardOperations.failure_count} + 1` } : {}),
							updated_at: now,
						})
						.where(
							and(
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
							),
						)
						.returning(),
					input.id,
				),
			),
		succeed: (id: string, leaseToken: string, workerId: string) =>
			withLease(
				{ id, leaseToken, workerId },
				leased(
					db
						.update(boardOperations)
						.set({
							state: "succeeded",
							lease_token: null,
							lease_owner: null,
							lease_expires_at: null,
							last_error_code: null,
							last_error_message: null,
							updated_at: now,
							finished_at: now,
						})
						.where(
							and(
								eq(boardOperations.id, id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, leaseToken),
								eq(boardOperations.lease_owner, workerId),
								gt(boardOperations.lease_expires_at, now),
								sql`cardinality(${boardOperations.ambiguous_mutations}) = 0`,
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
			withLease(
				input,
				leased(
					db
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
								eq(boardOperations.id, input.id),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, input.leaseToken),
								eq(boardOperations.lease_owner, input.workerId),
								gt(boardOperations.lease_expires_at, now),
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
