import { Effect, Layer, Option, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { BoardDeletion } from "../src/board-deletion.ts";
import { BoardDeletionWorker, boardDeletionWorkerLayer } from "../src/board-deletion-worker.ts";
import { Boards } from "../src/boards.ts";
import { CloudflareDeletionApi } from "../src/cloudflare-deletion-api.ts";
import { CloudflareDns } from "../src/cloudflare-dns.ts";
import { Dashboard } from "../src/dashboard.ts";
import { FlyApiError, FlyBoardApi } from "../src/fly-board-api.ts";
import { FlyDeletionApi } from "../src/fly-deletion-api.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { realPostgres, runFresh } from "./fixture.ts";
import { makeFakeProvider, provisionerFor, request, settings } from "./fixtures/provisioner.ts";

const confirmation = { confirmation_name: request.name, idempotency_key: "delete-1" };
const setup = Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const board = yield* (yield* Boards).request(request);
	return {
		board,
		deletion: yield* BoardDeletion,
		operations: yield* Operations,
		dashboard: yield* Dashboard,
		sql: yield* SqlClient.SqlClient,
	};
});

describe("board deletion", () => {
	test("atomically cancels never-claimed provisioning, preserves audit/idempotency and frees quota", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board, deletion, operations, dashboard, sql } = yield* setup;
				yield* sql`INSERT INTO board_postgres_secrets (board_id, bootstrap_ciphertext) VALUES (${board.id}, 'encrypted-credential-fixture')`;
				for (let i = 0; i < 4; i++) yield* (yield* Boards).request({ ...request, idempotency_key: `extra-${i}` });
				expect(yield* deletion.request(request.owner_id, board.id, confirmation)).toEqual({ deleted: true });
				expect(yield* deletion.request(request.owner_id, board.id, confirmation)).toEqual({ deleted: true });
				expect(Option.isNone(yield* dashboard.get(request.owner_id, board.id))).toBe(true);
				expect(yield* sql`SELECT board_id FROM board_postgres_secrets WHERE board_id = ${board.id}`).toEqual([]);
				expect((yield* dashboard.list(request.owner_id)).boards).toHaveLength(4);
				expect(
					yield* sql`SELECT kind, state FROM board_operations WHERE board_id = ${board.id} ORDER BY created_at, id`,
				).toMatchObject([
					{ kind: "provision", state: "failed" },
					{ kind: "delete", state: "succeeded" },
				]);
				yield* (yield* Boards).request({ ...request, idempotency_key: "quota-freed" });
				expect(Result.isFailure(yield* Effect.result((yield* Boards).request(request)))).toBe(true);
				expect(
					Result.isFailure(
						yield* Effect.result(
							operations.enqueue({ ...request, board_id: board.id, kind: "backup", idempotency_key: "backup-deleted" }),
						),
					),
				).toBe(true);
			}),
		);
	});

	test("requires exact confirmation and owner, and never cancels a running operation", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board, deletion, operations } = yield* setup;
				for (const [owner, name, tag] of [
					["other", request.name, "BoardNotFound"],
					[request.owner_id, "wrong", "BoardConfirmationMismatch"],
				]) {
					const result = yield* Effect.result(
						deletion.request(owner!, board.id, { ...confirmation, confirmation_name: name! }),
					);
					expect(result).toMatchObject({ failure: { _tag: tag } });
				}
				yield* operations.claim("worker", 30_000, "provision");
				expect(yield* Effect.result(deletion.request(request.owner_id, board.id, confirmation))).toMatchObject({
					failure: { _tag: "OperationAlreadyActive" },
				});
			}),
		);
	});

	test("rejects cross-operation idempotency reuse and ambiguous provider mutations", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board, deletion, operations } = yield* setup;
				expect(
					yield* Effect.result(
						deletion.request(request.owner_id, board.id, { ...confirmation, idempotency_key: request.idempotency_key }),
					),
				).toMatchObject({ failure: { _tag: "IdempotencyConflict" } });
				const operation = Option.getOrThrow(yield* operations.claim("worker", 30_000));
				const lease = { id: operation.id, leaseToken: operation.lease_token!, workerId: "worker" };
				yield* operations.markAmbiguousMutation({ ...lease, mutation: "app_create" });
				yield* operations.fail({ ...lease, errorCode: "ambiguous", errorMessage: "unknown" });
				expect(yield* Effect.result(deletion.request(request.owner_id, board.id, confirmation))).toMatchObject({
					failure: { _tag: "BoardDeletionUnsafe" },
				});
			}),
		);
	});

	test.skipIf(!realPostgres)("serializes concurrent deletion against queue claims and duplicate requests", async () => {
		await runFresh(
			Effect.gen(function* () {
				const { board, deletion, operations } = yield* setup;
				const results = yield* Effect.all(
					[
						Effect.result(deletion.request(request.owner_id, board.id, confirmation)),
						Effect.result(deletion.request(request.owner_id, board.id, confirmation)),
						Effect.result(operations.claim("racing-worker", 30_000)),
					],
					{ concurrency: "unbounded" },
				);
				const claim = results[2];
				if (claim && Result.isSuccess(claim) && Option.isSome(claim.success)) {
					expect(results[0]).toMatchObject({ failure: { _tag: "OperationAlreadyActive" } });
					expect(results[1]).toMatchObject({ failure: { _tag: "OperationAlreadyActive" } });
				} else {
					expect(results[0]).toMatchObject({ success: { deleted: true } });
					expect(results[1]).toMatchObject({ success: { deleted: true } });
				}
			}),
		);
	});
});

const providerDeletion = (
	provider: ReturnType<typeof makeFakeProvider>,
	mode: "ok" | "partial" | "app_pending" | "drift" | "app_drift" | "volume_drift",
) => {
	let removedMachine = false;
	let removedVolume = false;
	let first = true;
	let appAttempts = 0;
	const calls: string[] = [];
	const fly = {
		...provider.fake,
		getApp: (name: string) =>
			provider.fake
				.getApp(name)
				.pipe(Effect.map(Option.map((app) => (mode === "app_drift" ? { ...app, id: "replacement-app" } : app)))),
		getMachine: (name: string, id: string) =>
			removedMachine ? Effect.succeedNone : provider.fake.getMachine(name, id),
		getVolume: (name: string, id: string) => (removedVolume ? Effect.succeedNone : provider.fake.getVolume(name, id)),
		listMachines: (name: string) =>
			removedMachine
				? Effect.succeed([])
				: provider.fake
						.listMachines(name)
						.pipe(
							Effect.map((rows) => (mode === "drift" ? rows.map((row) => ({ ...row, id: "foreign-machine" })) : rows)),
						),
		listVolumes: (name: string) =>
			removedVolume
				? Effect.succeed([])
				: provider.fake
						.listVolumes(name)
						.pipe(
							Effect.map((rows) =>
								mode === "volume_drift" ? rows.map((volume) => ({ ...volume, id: "foreign-volume" })) : rows,
							),
						),
	};
	const remove = {
		app: (_app: string) =>
			Effect.sync(() => {
				calls.push("app");
				appAttempts += 1;
				if (mode !== "app_pending" || appAttempts > 1) provider.set.app(undefined);
			}),
		machine: (_app: string, _id: string) =>
			Effect.sync(() => {
				calls.push("machine");
				removedMachine = true;
			}),
		volume: (_app: string, _id: string) =>
			Effect.gen(function* () {
				calls.push("volume");
				removedVolume = true;
				if (mode === "partial" && first) {
					first = false;
					return yield* new FlyApiError({ operation: "delete_volume", reason: "transport", status: null });
				}
			}),
	};
	const removeDns = {
		record: (id: string) =>
			Effect.sync(() => {
				const found = provider.networking.state.records.find((record) => record.id === id);
				if (found) calls.push(`dns:${found.type}`);
				provider.networking.state.records = provider.networking.state.records.filter((record) => record.id !== id);
			}),
	};
	return {
		calls,
		layer: boardDeletionWorkerLayer(settings).pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(FlyBoardApi, fly),
					Layer.succeed(FlyDeletionApi, remove),
					Layer.succeed(CloudflareDns, provider.networking.dns),
					Layer.succeed(CloudflareDeletionApi, removeDns),
				),
			),
		),
	};
};

for (const mode of ["ok", "partial", "app_pending", "drift", "app_drift", "volume_drift"] as const)
	test(`provider deletion ${mode}: verifies teardown and retains boards until confirmed`, async () => {
		const provider = makeFakeProvider();
		const deletionProvider = providerDeletion(provider, mode);
		await runFresh(
			Effect.gen(function* () {
				const { board, deletion, operations, dashboard, sql } = yield* setup;
				yield* sql`INSERT INTO board_postgres_secrets (board_id, bootstrap_ciphertext) VALUES (${board.id}, 'encrypted-credential-fixture')`;
				const provision = Option.getOrThrow(yield* operations.claim("provisioner", 90_000));
				yield* Provisioner.use((service) => service.run(provision, "provisioner")).pipe(
					Effect.provide(provisionerFor(provider)),
				);
				expect(yield* deletion.request(request.owner_id, board.id, confirmation)).toEqual({ deleted: false });
				expect(Option.getOrThrow(yield* dashboard.get(request.owner_id, board.id)).phase).toBe("deleting");
				const worker = yield* BoardDeletionWorker;
				const operation = Option.getOrThrow(yield* operations.claim("delete-worker", 90_000, "delete"));
				const outcome = yield* worker.run(operation, "delete-worker");
				if (mode.endsWith("drift")) {
					expect(outcome).toBe("blocked");
					expect(deletionProvider.calls).toEqual([]);
					expect(yield* sql`SELECT board_id FROM board_postgres_secrets WHERE board_id = ${board.id}`).toHaveLength(1);
					expect(Option.getOrThrow(yield* dashboard.get(request.owner_id, board.id)).phase).toBe("deletion_blocked");
					expect(yield* Effect.result(deletion.request(request.owner_id, board.id, confirmation))).toMatchObject({
						failure: { _tag: "BoardDeletionFailed" },
					});
					return;
				}
				expect(outcome).toBe("requeued");
				expect(deletionProvider.calls).toEqual(["dns:A", "dns:TXT"]);
				expect(Option.getOrThrow(yield* operations.latest(board.id, "delete"))).toMatchObject({
					checkpoint: "dns_withdrawn",
					state: "queued",
					failure_count: 0,
				});
				yield* sql`UPDATE board_operations SET available_at = clock_timestamp() WHERE kind = 'delete'`;
				const afterDns = Option.getOrThrow(yield* operations.claim("delete-worker-2", 90_000, "delete"));
				const afterDnsOutcome = yield* worker.run(afterDns, "delete-worker-2");
				if (mode === "partial" || mode === "app_pending") {
					expect(afterDnsOutcome).toBe("requeued");
					expect(yield* sql`SELECT board_id FROM board_postgres_secrets WHERE board_id = ${board.id}`).toHaveLength(1);
					expect(Option.isSome(yield* dashboard.get(request.owner_id, board.id))).toBe(true);
					yield* sql`UPDATE board_operations SET available_at = clock_timestamp() WHERE kind = 'delete'`;
					const resumed = Option.getOrThrow(yield* operations.claim("delete-worker-3", 90_000, "delete"));
					expect(yield* worker.run(resumed, "delete-worker-3")).toBe("deleted");
				} else expect(afterDnsOutcome).toBe("deleted");
				expect(deletionProvider.calls).toEqual([
					"dns:A",
					"dns:TXT",
					"machine",
					"volume",
					"app",
					...(mode === "app_pending" ? ["app"] : []),
				]);
				expect(provider.networking.state.records).toEqual([]);
				expect(provider.resources().apps).toBe(0);
				expect(Option.isNone(yield* dashboard.get(request.owner_id, board.id))).toBe(true);
				expect(yield* sql`SELECT board_id FROM board_postgres_secrets WHERE board_id = ${board.id}`).toEqual([]);
				expect(yield* deletion.request(request.owner_id, board.id, confirmation)).toEqual({ deleted: true });
			}).pipe(Effect.provide(deletionProvider.layer)),
		);
	});

test.each(["content", "ttl"] as const)("blocks before teardown when a DNS record has %s drift", async (drift) => {
	const provider = makeFakeProvider();
	const deletionProvider = providerDeletion(provider, "ok");
	await runFresh(
		Effect.gen(function* () {
			const { board, deletion, operations, dashboard } = yield* setup;
			const provision = Option.getOrThrow(yield* operations.claim("provisioner", 90_000));
			yield* Provisioner.use((service) => service.run(provision, "provisioner")).pipe(
				Effect.provide(provisionerFor(provider)),
			);
			provider.networking.state.records[0] = {
				...provider.networking.state.records[0]!,
				...(drift === "content" ? { content: "203.0.113.99" } : { ttl: 120 }),
			};
			yield* deletion.request(request.owner_id, board.id, confirmation);
			const operation = Option.getOrThrow(yield* operations.claim("delete-worker", 90_000, "delete"));
			expect(yield* (yield* BoardDeletionWorker).run(operation, "delete-worker")).toBe("blocked");
			expect(deletionProvider.calls).toEqual([]);
			expect(provider.resources()).toMatchObject({ apps: 1, machines: 1, volumes: 1 });
			expect(provider.networking.state.records).toHaveLength(2);
			expect(Option.getOrThrow(yield* dashboard.get(request.owner_id, board.id)).phase).toBe("deletion_blocked");
		}).pipe(Effect.provide(deletionProvider.layer)),
	);
});

test("refuses destructive provider calls when observation outlives the lease", async () => {
	const provider = makeFakeProvider();
	await runFresh(
		Effect.gen(function* () {
			const { board, deletion, operations, sql } = yield* setup;
			const provision = Option.getOrThrow(yield* operations.claim("provisioner", 90_000));
			yield* Provisioner.use((service) => service.run(provision, "provisioner")).pipe(
				Effect.provide(provisionerFor(provider)),
			);
			yield* deletion.request(request.owner_id, board.id, confirmation);
			const operation = Option.getOrThrow(yield* operations.claim("delete-worker", 90_000, "delete"));
			let observations = 0;
			const calls: string[] = [];
			const layer = boardDeletionWorkerLayer(settings).pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(FlyBoardApi, {
							...provider.fake,
							getApp: (name: string) =>
								Effect.gen(function* () {
									observations += 1;
									if (observations === 2)
										yield* sql`UPDATE board_operations SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${operation.id}`.pipe(
											Effect.orDie,
										);
									return yield* provider.fake.getApp(name);
								}),
						}),
						Layer.succeed(FlyDeletionApi, {
							app: () =>
								Effect.sync(() => {
									calls.push("app");
								}),
							machine: () =>
								Effect.sync(() => {
									calls.push("machine");
								}),
							volume: () =>
								Effect.sync(() => {
									calls.push("volume");
								}),
						}),
						Layer.succeed(CloudflareDns, provider.networking.dns),
						Layer.succeed(CloudflareDeletionApi, {
							record: () =>
								Effect.sync(() => {
									calls.push("dns");
								}),
						}),
					),
				),
			);
			expect(
				yield* Effect.result(
					BoardDeletionWorker.use((worker) => worker.run(operation, "delete-worker")).pipe(Effect.provide(layer)),
				),
			).toMatchObject({ failure: { _tag: "LeaseLost" } });
			expect(calls).toEqual([]);
		}),
	);
});

test("does not spend the provider failure budget on healthy polls or reclaimed claims", async () => {
	const provider = makeFakeProvider();
	const deletionProvider = providerDeletion(provider, "ok");
	await runFresh(
		Effect.gen(function* () {
			const { board, deletion, operations, sql } = yield* setup;
			const provision = Option.getOrThrow(yield* operations.claim("provisioner", 90_000));
			yield* Provisioner.use((service) => service.run(provision, "provisioner")).pipe(
				Effect.provide(provisionerFor(provider)),
			);
			yield* deletion.request(request.owner_id, board.id, confirmation);
			yield* sql`UPDATE board_operations SET attempt = 50 WHERE kind = 'delete' AND board_id = ${board.id}`;
			const operation = Option.getOrThrow(yield* operations.claim("delete-worker", 90_000, "delete"));
			expect(
				yield* BoardDeletionWorker.use((worker) => worker.run(operation, "delete-worker")).pipe(
					Effect.provide(deletionProvider.layer),
				),
			).toBe("requeued");
			expect(Option.getOrThrow(yield* operations.latest(board.id, "delete"))).toMatchObject({
				state: "queued",
				attempt: 51,
				failure_count: 0,
				last_error_code: "deletion_pending",
			});
		}),
	);
});

test("persists the provider failure that exhausts the deletion budget", async () => {
	const provider = makeFakeProvider();
	await runFresh(
		Effect.gen(function* () {
			const { board, deletion, operations } = yield* setup;
			const provision = Option.getOrThrow(yield* operations.claim("provisioner", 90_000));
			yield* Provisioner.use((service) => service.run(provision, "provisioner")).pipe(
				Effect.provide(provisionerFor(provider)),
			);
			yield* deletion.request(request.owner_id, board.id, confirmation);
			const operation = Option.getOrThrow(yield* operations.claim("delete-worker", 90_000, "delete"));
			const layer = boardDeletionWorkerLayer({ ...settings, maxFailures: 1 }).pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(FlyBoardApi, {
							...provider.fake,
							getApp: () => Effect.fail(new FlyApiError({ operation: "get_app", reason: "transport", status: null })),
						}),
						Layer.succeed(FlyDeletionApi, {
							app: () => Effect.void,
							machine: () => Effect.void,
							volume: () => Effect.void,
						}),
						Layer.succeed(CloudflareDns, provider.networking.dns),
						Layer.succeed(CloudflareDeletionApi, { record: () => Effect.void }),
					),
				),
			);
			expect(
				yield* BoardDeletionWorker.use((worker) => worker.run(operation, "delete-worker")).pipe(Effect.provide(layer)),
			).toBe("blocked");
			expect(Option.getOrThrow(yield* operations.latest(board.id, "delete"))).toMatchObject({
				state: "failed",
				failure_count: 1,
				last_error_code: "deletion_provider_unavailable",
			});
		}),
	);
});
