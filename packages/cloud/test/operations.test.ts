import { eq, sql } from "drizzle-orm";
import { DateTime, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { boardOperations, boards } from "../src/schema.ts";
import { realPostgres, runFresh } from "./fixture.ts";

const boardRequest = {
	owner_id: "user-1",
	name: "My board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-1",
} as const;

describe("Operations", () => {
	test("claims only the requested operation kind", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				expect(Option.isNone(yield* operations.claim("backup-worker", 30_000, "backup"))).toBe(true);
				expect(Option.getOrThrow(yield* operations.claim("provision-worker", 30_000, "provision")).kind).toBe(
					"provision",
				);
			}),
		);
	});

	test.skipIf(!realPostgres)("allows only one concurrent claim of an operation", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const claimed = yield* Effect.all(
					[operations.claim("worker-1", 30_000), operations.claim("worker-2", 30_000)],
					{ concurrency: "unbounded" },
				);
				expect(claimed.filter(Option.isSome)).toHaveLength(1);
			}),
		);
	});

	test("reclaims an expired lease and fences the stale worker", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const database = yield* Database;
				const first = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				yield* database
					.update(boardOperations)
					.set({ lease_expires_at: sql<Date>`clock_timestamp() - interval '1 second'` })
					.where(eq(boardOperations.id, first.id));
				const second = Option.getOrThrow(yield* operations.claim("worker-2", 30_000));
				expect(second.id).toBe(first.id);
				expect(second.attempt).toBe(2);
				if (!first.lease_token) return yield* Effect.die("Claim returned no lease token");
				const stale = yield* Effect.exit(
					operations.checkpoint({
						id: first.id,
						leaseToken: first.lease_token,
						workerId: "worker-1",
						expected: "requested",
						next: "app_created",
					}),
				);
				expect(Exit.isFailure(stale)).toBe(true);
			}),
		);
	});

	test("compare-and-swaps checkpoints and preserves them when requeued", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const claimed = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				if (!claimed.lease_token) return yield* Effect.die("Claim returned no lease token");
				const leaseToken = claimed.lease_token;
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							operations.checkpoint({
								id: claimed.id,
								leaseToken,
								workerId: "worker-1",
								expected: "wrong",
								next: "app_created",
							}),
						),
					),
				).toBe(true);
				const checkpointed = yield* operations.checkpoint({
					id: claimed.id,
					leaseToken,
					workerId: "worker-1",
					expected: "requested",
					next: "app_created",
				});
				const availableAt = yield* DateTime.nowAsDate;
				const requeued = yield* operations.requeue({
					id: checkpointed.id,
					leaseToken,
					workerId: "worker-1",
					availableAt,
					errorCode: "ambiguous_provider_result",
					errorMessage: "Observe before retry",
				});
				expect(requeued.checkpoint).toBe("app_created");
				expect(requeued.state).toBe("queued");
			}),
		);
	});

	test("serializes board mutations and releases the board after success", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const blocked = yield* Effect.exit(
					operations.enqueue({
						board_id: board.id,
						owner_id: "user-1",
						kind: "backup",
						requested_by: "user-1",
						idempotency_key: "backup-1",
					}),
				);
				expect(Exit.isFailure(blocked)).toBe(true);
				const provision = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				if (!provision.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* operations.succeed(provision.id, provision.lease_token, "worker-1");
				const backup = yield* operations.enqueue({
					board_id: board.id,
					owner_id: "user-1",
					kind: "backup",
					requested_by: "user-1",
					idempotency_key: "backup-1",
				});
				expect(backup.state).toBe("queued");
			}),
		);
	});

	test("recovers an active-operation conflict inside a caller transaction", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const database = yield* Database;
				const sqlClient = yield* SqlClient.SqlClient;
				yield* sqlClient.withTransaction(
					Effect.gen(function* () {
						yield* database.update(boards).set({ name: "Updated" }).where(eq(boards.id, board.id));
						yield* operations
							.enqueue({
								board_id: board.id,
								owner_id: "user-1",
								kind: "backup",
								requested_by: "user-1",
								idempotency_key: "stop-conflict",
							})
							.pipe(Effect.catchTag("OperationAlreadyActive", () => Effect.void));
					}),
				);
				expect(yield* database.select({ name: boards.name }).from(boards).where(eq(boards.id, board.id))).toEqual([
					{ name: "Updated" },
				]);
			}),
		);
	});

	test.skipIf(!realPostgres)("replays a concurrent matching key inside caller transactions", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const sqlClient = yield* SqlClient.SqlClient;
				const provision = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				if (!provision.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* operations.succeed(provision.id, provision.lease_token, "worker-1");
				const input = {
					board_id: board.id,
					owner_id: "user-1",
					kind: "backup",
					requested_by: "user-1",
					idempotency_key: "concurrent-backup",
				} as const;
				const repeated = yield* Effect.all(
					[sqlClient.withTransaction(operations.enqueue(input)), sqlClient.withTransaction(operations.enqueue(input))],
					{ concurrency: "unbounded" },
				);
				expect(new Set(repeated.map(({ id }) => id)).size).toBe(1);
			}),
		);
	});

	test("replays matching operation requests and rejects key reuse with a different body", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const provision = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				if (!provision.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* operations.succeed(provision.id, provision.lease_token, "worker-1");
				const otherBoard = yield* (yield* Boards).request({
					...boardRequest,
					name: "Other board",
					idempotency_key: "provision-2",
				});
				const input = {
					board_id: board.id,
					owner_id: "user-1",
					kind: "backup",
					requested_by: "user-1",
					idempotency_key: "control-1",
				} as const;
				const first = yield* operations.enqueue(input);
				expect((yield* operations.enqueue(input)).id).toBe(first.id);
				expect(
					Exit.isFailure(yield* Effect.exit(operations.enqueue({ ...input, board_id: otherBoard.id }))),
				).toBe(true);
			}),
		);
	});

	test("refuses to enqueue work through another owner's board", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const attempt = yield* Effect.exit(
					operations.enqueue({
						board_id: board.id,
						owner_id: "user-2",
						kind: "backup",
						requested_by: "user-2",
						idempotency_key: "cross-owner-stop",
					}),
				);
				expect(Exit.isFailure(attempt)).toBe(true);
			}),
		);
	});

	test("rejects every stale-token lease mutation", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const claimed = Option.getOrThrow(yield* operations.claim("worker-1", 30_000));
				const staleToken = "00000000-0000-4000-8000-000000000000";
				const failures = yield* Effect.all([
					Effect.exit(
						operations.renew({
							id: claimed.id,
							leaseToken: staleToken,
							workerId: "worker-1",
							leaseMilliseconds: 30_000,
						}),
					),
					Effect.exit(operations.succeed(claimed.id, staleToken, "worker-1")),
					Effect.exit(
						operations.fail({
							id: claimed.id,
							leaseToken: staleToken,
							workerId: "worker-1",
							errorCode: "failed",
							errorMessage: "failed",
						}),
					),
				]);
				expect(failures.every(Exit.isFailure)).toBe(true);
			}),
		);
	});

	test("rejects invalid lease durations without claiming work", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				expect(Exit.isFailure(yield* Effect.exit(operations.claim("worker-1", 0)))).toBe(true);
				expect(Option.isSome(yield* operations.claim("worker-1", 30_000))).toBe(true);
			}),
		);
	});

	test.skipIf(!realPostgres)("expires leases by wall time inside a long transaction", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const sqlClient = yield* SqlClient.SqlClient;
				yield* sqlClient.withTransaction(
					Effect.gen(function* () {
						const claimed = Option.getOrThrow(yield* operations.claim("worker-1", 25));
						if (!claimed.lease_token) return yield* Effect.die("Claim returned no lease token");
						yield* Effect.sleep("50 millis");
						expect(
							Exit.isFailure(
								yield* Effect.exit(
									operations.checkpoint({
										id: claimed.id,
										leaseToken: claimed.lease_token,
										workerId: "worker-1",
										expected: "requested",
										next: "app_created",
									}),
								),
							),
						).toBe(true);
					}),
				);
			}),
		);
	});

	test.skipIf(!realPostgres)("rechecks lease expiry after waiting for a row lock", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(boardRequest);
				const operations = yield* Operations;
				const database = yield* Database;
				const sqlClient = yield* SqlClient.SqlClient;
				const claimed = Option.getOrThrow(yield* operations.claim("worker-1", 250));
				if (!claimed.lease_token) return yield* Effect.die("Claim returned no lease token");
				const locked = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const holder = yield* Effect.forkChild(
					sqlClient.withTransaction(
						Effect.gen(function* () {
							yield* database
								.select({ id: boardOperations.id })
								.from(boardOperations)
								.where(eq(boardOperations.id, claimed.id))
								.for("update");
							yield* Deferred.succeed(locked, undefined);
							yield* Deferred.await(release);
						}),
					),
				);
				yield* Deferred.await(locked);
				const renewal = yield* Effect.forkChild(
					operations.renew({
						id: claimed.id,
						leaseToken: claimed.lease_token,
						workerId: "worker-1",
						leaseMilliseconds: 30_000,
					}),
				);
				yield* Effect.sleep("300 millis");
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(holder);
				expect(Exit.isFailure(yield* Effect.exit(Fiber.join(renewal)))).toBe(true);
			}),
		);
	});
});
