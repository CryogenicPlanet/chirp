import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { BoardSetup, boardSetupLayer } from "../src/board-setup.ts";
import { BoardDeletion } from "../src/board-deletion.ts";
import { Boards } from "../src/boards.ts";
import { FlyBoardApi } from "../src/fly-board-api.ts";
import { FlySetupApi } from "../src/fly-setup-api.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { runFresh, realPostgres } from "./fixture.ts";
import { makeFakeProvider, provisionerFor, request, settings } from "./fixtures/provisioner.ts";

test("only ready live owned deployment can issue; provider drift and deletion block issuance", async () => {
	const provider = makeFakeProvider();
	let calls = 0;
	const layer = boardSetupLayer(settings.organization).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(FlyBoardApi, provider.fake),
				Layer.succeed(FlySetupApi, {
					wake: () => Effect.void,
					issue: () =>
						Effect.sync(() => {
							calls++;
							return { code: "private-code", expires_at: new Date(Date.now() + 890000).toISOString() };
						}),
				}),
			),
		),
	);
	await runFresh(
		Effect.gen(function* () {
			yield* migrateCloudDatabase;
			const board = yield* (yield* Boards).request(request);
			const service = yield* BoardSetup;
			expect(yield* Effect.result(service.issue("foreign", board.id))).toMatchObject({
				failure: { _tag: "BoardNotFound" },
			});
			expect(yield* Effect.result(service.issue(request.owner_id, board.id))).toMatchObject({
				failure: { code: "setup_code_unavailable" },
			});
			const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker", 90000));
			yield* Provisioner.use((p) => p.run(operation, "worker")).pipe(Effect.provide(provisionerFor(provider)));
			expect(yield* service.issue(request.owner_id, board.id)).toMatchObject({
				code: "private-code",
				onboarding_url: `https://${board.slug}.${settings.boardsDomain}/onboarding`,
			});
			const sql = yield* SqlClient.SqlClient;
			yield* sql`UPDATE board_deployments SET app_id = 'foreign' WHERE board_id = ${board.id}`;
			expect(yield* Effect.result(service.issue(request.owner_id, board.id))).toMatchObject({
				failure: { code: "setup_code_unavailable" },
			});
			yield* (yield* BoardDeletion).request(request.owner_id, board.id, {
				confirmation_name: request.name,
				idempotency_key: "delete",
			});
			expect(yield* Effect.result(service.issue(request.owner_id, board.id))).toMatchObject({
				failure: { code: "setup_code_unavailable" },
			});
			expect(calls).toBe(1);
		}).pipe(Effect.provide(layer)),
	);
});

test.skipIf(!realPostgres)(
	"holds board lock across issuance so deletion waits and concurrent generation fails",
	async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker", 90000));
				yield* Provisioner.use((p) => p.run(operation, "worker")).pipe(Effect.provide(provisionerFor(provider)));
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const layer = boardSetupLayer(settings.organization).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(FlyBoardApi, provider.fake),
							Layer.succeed(FlySetupApi, {
								wake: () => Effect.void,
								issue: () =>
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
										Effect.as({ code: "private", expires_at: "expiry" }),
									),
							}),
						),
					),
				);
				const issue = BoardSetup.use((s) => s.issue(request.owner_id, board.id)).pipe(Effect.provide(layer));
				const first = yield* Effect.forkChild(issue);
				yield* Deferred.await(entered);
				const second = yield* Effect.result(issue);
				expect(second._tag).toBe("Failure");
				const deletion = yield* Effect.forkChild(
					(yield* BoardDeletion).request(request.owner_id, board.id, {
						confirmation_name: request.name,
						idempotency_key: "delete",
					}),
				);
				yield* Effect.sleep("30 millis");
				expect(deletion.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(release, undefined);
				expect(yield* Fiber.join(first)).toMatchObject({ code: "private" });
				expect(yield* Fiber.join(deletion)).toEqual({ deleted: false });
				expect(yield* Effect.result(issue)).toMatchObject({ failure: { code: "setup_code_unavailable" } });
			}),
		);
	},
);

test("sleeping boards wake before exec; storage and origin drift refuse both", async () => {
	const provider = makeFakeProvider();
	await runFresh(
		Effect.gen(function* () {
			yield* migrateCloudDatabase;
			const board = yield* (yield* Boards).request(request);
			const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker", 90000));
			yield* Provisioner.use((p) => p.run(operation, "worker")).pipe(Effect.provide(provisionerFor(provider)));
			for (const mode of ["sleep", "mount", "origin", "wake-drift"] as const) {
				let woke = false;
				let issued = false;
				const layer = boardSetupLayer(settings.organization).pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(FlyBoardApi, {
								...provider.fake,
								getMachine: (app, machine) =>
									provider.fake.getMachine(app, machine).pipe(
										Effect.map(
											Option.map((found) => ({
												...found,
												state: woke ? "started" : "stopped",
												config: {
													...found.config,
													...(mode === "mount" || (mode === "wake-drift" && woke)
														? { mounts: [{ volume: "foreign", path: "/data" }] }
														: {}),
													...(mode === "origin"
														? { env: { ...found.config.env, PUBLIC_ORIGIN: "https://foreign.test" } }
														: {}),
												},
											})),
										),
									),
							}),
							Layer.succeed(FlySetupApi, {
								wake: (hostname) =>
									Effect.sync(() => {
										expect(hostname).toBe(`${board.slug}.${settings.boardsDomain}`);
										woke = true;
									}),
								issue: () =>
									Effect.sync(() => {
										issued = true;
										return { code: "private", expires_at: "expiry" };
									}),
							}),
						),
					),
				);
				const result = yield* Effect.result(
					BoardSetup.use((s) => s.issue(request.owner_id, board.id)).pipe(Effect.provide(layer)),
				);
				expect(result._tag).toBe(mode === "sleep" ? "Success" : "Failure");
				expect(issued).toBe(mode === "sleep");
				expect(woke).toBe(mode === "sleep" || mode === "wake-drift");
			}
		}),
	);
});
