import { Context, Crypto, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	BoardNotFound,
	type EnqueueOperation,
	IdempotencyConflict,
	InvalidLeaseDuration,
	LeaseLost,
	Operation,
	OperationAlreadyActive,
} from "./operation.ts";

const operations = Schema.decodeUnknownEffect(Schema.Array(Operation));
const encodeRequestHash = Schema.encodeSync(
	Schema.fromJsonString(Schema.Struct({ board_id: Schema.String, owner_id: Schema.String, kind: Schema.String })),
);
const ids = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })));

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	const columns = sql`id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash,
		available_at::text AS available_at, attempt, lease_token, lease_owner,
		lease_expires_at::text AS lease_expires_at, last_error_code, last_error_message,
		created_at::text AS created_at, updated_at::text AS updated_at, finished_at::text AS finished_at`;
	const decodeOne = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
		effect.pipe(
			Effect.flatMap(operations),
			Effect.map((found) => Option.fromNullishOr(found[0])),
		);
	const byRequest = (requestedBy: string, idempotencyKey: string) =>
		decodeOne(
			sql`SELECT ${columns} FROM board_operations WHERE requested_by = ${requestedBy} AND idempotency_key = ${idempotencyKey}`,
		);
	const activeForBoard = (boardId: string) =>
		decodeOne(
			sql`SELECT ${columns} FROM board_operations WHERE board_id = ${boardId} AND state IN ('queued', 'running')`,
		);
	const ownedBoard = (boardId: string, ownerId: string) =>
		sql`SELECT id FROM boards WHERE id = ${boardId} AND owner_id = ${ownerId}`.pipe(
			Effect.flatMap(ids),
			Effect.map((found) => found.length > 0),
		);
	const leased = <E, R>(effect: Effect.Effect<unknown, E, R>, operationId: string) =>
		decodeOne(effect).pipe(
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
		sql.withTransaction(
			Effect.gen(function* () {
				const locked = yield* sql`SELECT id FROM board_operations
					WHERE id = ${input.id} AND state = 'running' AND lease_token = ${input.leaseToken}
						AND lease_owner = ${input.workerId}
					FOR UPDATE`.pipe(Effect.flatMap(ids));
				if (!locked[0]) return yield* new LeaseLost({ operationId: input.id });
				return yield* effect;
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
				const insert = sql.withTransaction(
					decodeOne(sql`INSERT INTO board_operations (
						id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash
					) VALUES (
						${id}, ${input.board_id}, ${input.kind}, 'queued', 'requested', ${input.requested_by},
						${input.idempotency_key}, ${requestHash}
					) RETURNING ${columns}`).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.die("Operation insert returned no row"),
								onSome: Effect.succeed,
							}),
						),
					),
				);
				return yield* insert.pipe(
					Effect.catchTag("SqlError", (error) =>
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
				Effect.flatMap(([duration, leaseToken]) =>
					decodeOne(sql`WITH candidate AS (
						SELECT id FROM board_operations
						WHERE (state = 'queued' AND available_at <= clock_timestamp())
							OR (state = 'running' AND lease_expires_at <= clock_timestamp())
						ORDER BY available_at, created_at, id
						FOR UPDATE SKIP LOCKED
						LIMIT 1
					)
					UPDATE board_operations o SET
						state = 'running', lease_token = ${leaseToken}, lease_owner = ${workerId},
						lease_expires_at = clock_timestamp() + ${duration} * interval '1 millisecond',
						attempt = attempt + 1, updated_at = clock_timestamp()
					FROM candidate WHERE o.id = candidate.id
					RETURNING o.id, board_id, kind, state, checkpoint, requested_by, idempotency_key, request_hash,
						available_at::text AS available_at, attempt, lease_token, lease_owner,
						lease_expires_at::text AS lease_expires_at, last_error_code, last_error_message,
						created_at::text AS created_at, updated_at::text AS updated_at, finished_at::text AS finished_at`),
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
							sql`UPDATE board_operations SET
					lease_expires_at = clock_timestamp() + ${duration} * interval '1 millisecond',
					updated_at = clock_timestamp()
				WHERE id = ${input.id} AND state = 'running' AND lease_token = ${input.leaseToken}
					AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
				RETURNING ${columns}`,
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
			withLease(
				input,
				leased(
					sql`UPDATE board_operations SET checkpoint = ${input.next}, updated_at = clock_timestamp()
				WHERE id = ${input.id} AND state = 'running' AND lease_token = ${input.leaseToken}
					AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
					AND checkpoint = ${input.expected}
				RETURNING ${columns}`,
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
			withLease(
				input,
				leased(
					sql`UPDATE board_operations SET
					state = 'queued', available_at = ${input.availableAt}, lease_token = NULL, lease_owner = NULL,
					lease_expires_at = NULL, last_error_code = ${input.errorCode},
					last_error_message = ${input.errorMessage}, updated_at = clock_timestamp()
				WHERE id = ${input.id} AND state = 'running' AND lease_token = ${input.leaseToken}
					AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
				RETURNING ${columns}`,
					input.id,
				),
			),
		succeed: (id: string, leaseToken: string, workerId: string) =>
			withLease(
				{ id, leaseToken, workerId },
				leased(
					sql`UPDATE board_operations SET state = 'succeeded', lease_token = NULL, lease_owner = NULL,
					lease_expires_at = NULL, last_error_code = NULL, last_error_message = NULL,
					updated_at = clock_timestamp(), finished_at = clock_timestamp()
				WHERE id = ${id} AND state = 'running' AND lease_token = ${leaseToken}
					AND lease_owner = ${workerId} AND lease_expires_at > clock_timestamp()
				RETURNING ${columns}`,
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
					sql`UPDATE board_operations SET state = 'failed', lease_token = NULL, lease_owner = NULL,
					lease_expires_at = NULL, last_error_code = ${input.errorCode},
					last_error_message = ${input.errorMessage}, updated_at = clock_timestamp(),
					finished_at = clock_timestamp()
				WHERE id = ${input.id} AND state = 'running' AND lease_token = ${input.leaseToken}
					AND lease_owner = ${input.workerId} AND lease_expires_at > clock_timestamp()
				RETURNING ${columns}`,
					input.id,
				),
			),
	};
});

export class Operations extends Context.Service<Operations, Effect.Success<typeof make>>()("comms/cloud/Operations") {}
export const operationsLayer = Layer.effect(Operations, make);
