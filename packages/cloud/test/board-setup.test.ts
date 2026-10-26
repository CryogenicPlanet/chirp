import { Deferred, Effect, Fiber, Layer, Option, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { BoardSetup, boardSetupLayer } from "../src/board-setup.ts";
import { BoardDeletion } from "../src/board-deletion.ts";
import { Boards } from "../src/boards.ts";
import { FlyBoardApi } from "../src/fly-board-api.ts";
import { FlySetupApi, SetupCodeIssue, type SetupIdentity } from "../src/fly-setup-api.ts";
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
					setupRequired: () => Effect.die("unexpected auth state read"),
					issue: () =>
						Effect.sync(() => {
							calls++;
							return {
								code: "private-code",
								expires_at: new Date(Date.now() + 890000).toISOString(),
								identities: 0,
							};
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
								setupRequired: () => Effect.die("unexpected auth state read"),
								issue: () =>
									Deferred.succeed(entered, undefined).pipe(
										Effect.andThen(Deferred.await(release)),
										Effect.as({ code: "private", expires_at: "expiry", identities: 0 }),
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
								setupRequired: () => Effect.die("unexpected auth state read"),
								issue: () =>
									Effect.sync(() => {
										issued = true;
										return { code: "private", expires_at: "expiry", identities: 0 };
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

const provisioned = Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const provider = makeFakeProvider();
	const board = yield* (yield* Boards).request(request);
	const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker", 90000));
	yield* Provisioner.use((p) => p.run(operation, "worker")).pipe(Effect.provide(provisionerFor(provider)));
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO "user" (id, name, email, "emailVerified") VALUES
		(${request.owner_id}, ${"  Rahul\u202e\n\tTarak  "}, 'owner@test.dev', true),
		('user-2', 'Someone else', 'other@test.dev', true)`;
	return { board, provider, host: `${board.slug}.${settings.boardsDomain}`, sql };
});
const linkAccount = (
	sql: SqlClient.SqlClient,
	id: string,
	user: string,
	provider: string,
	accountId: string,
	age: number,
) =>
	sql`INSERT INTO account (id, "accountId", "providerId", "userId", "updatedAt")
		VALUES (${id}, ${accountId}, ${provider}, ${user}, ${new Date(Date.parse("2026-10-01T00:00:00Z") - age * 60_000)})`;
const setupLayer = (
	provider: ReturnType<typeof makeFakeProvider>,
	api: {
		readonly setupRequired?: Effect.Effect<boolean, SetupCodeIssue>;
		// The reply's identities count; undefined is an older image's reply, which has no such key.
		readonly issue?: (identities: ReadonlyArray<SetupIdentity>) => Effect.Effect<number | undefined, SetupCodeIssue>;
	},
) =>
	boardSetupLayer(settings.organization).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(FlyBoardApi, provider.fake),
				Layer.succeed(FlySetupApi, {
					wake: () => Effect.void,
					setupRequired: () => api.setupRequired ?? Effect.die("unexpected auth state read"),
					issue: (_app, _machine, identities) =>
						(api.issue?.(identities) ?? Effect.die("unexpected setup exec")).pipe(
							Effect.map((linked) => ({
								code: "A1B2C3D4E5F60718",
								expires_at: new Date(Date.now() + 890000).toISOString(),
								identities: linked,
							})),
						),
				}),
			),
		),
	);

test("issue offers the owner's newest valid GitHub and Google identity, never another user's", async () => {
	await runFresh(
		Effect.gen(function* () {
			const { board, provider, host, sql } = yield* provisioned;
			yield* linkAccount(sql, "a1", request.owner_id, "github", "583231", 5);
			yield* linkAccount(sql, "a2", request.owner_id, "github", "77", 50);
			yield* linkAccount(sql, "a3", request.owner_id, "google", "not a sub!", 1);
			yield* linkAccount(sql, "a4", request.owner_id, "google", "109876543210", 60);
			yield* linkAccount(sql, "a5", request.owner_id, "github", "0123", 0);
			yield* linkAccount(sql, "a6", request.owner_id, "credential", "1", 0);
			yield* linkAccount(sql, "a7", "user-2", "github", "42", 0);
			const sent: Array<ReadonlyArray<SetupIdentity>> = [];
			const layer = setupLayer(provider, {
				issue: (identities) => Effect.sync(() => sent.push(identities)).pipe(Effect.as(identities.length)),
			});
			const service = yield* BoardSetup.pipe(Effect.provide(layer));
			expect(yield* service.issue(request.owner_id, board.id)).toMatchObject({
				identities: 2,
				setup_url: `https://${host}/setup#code=A1B2C3D4E5F60718`,
				onboarding_url: `https://${host}/onboarding`,
			});
			expect(sent).toEqual([
				[
					{ subject: "github:583231", label: "Rahul Tarak" },
					{ subject: "google:109876543210", label: "Rahul Tarak" },
				],
			]);
			expect(yield* Effect.result(service.issue("user-2", board.id))).toMatchObject({
				failure: { _tag: "BoardNotFound" },
			});
			expect(yield* Effect.result(service.open("user-2", board.id))).toMatchObject({
				failure: { _tag: "BoardNotFound" },
			});
			yield* sql`UPDATE "user" SET name = ${"\u0007"} WHERE id = ${request.owner_id}`;
			yield* service.issue(request.owner_id, board.id);
			expect(sent[1]?.map((identity) => identity.label)).toEqual(["GitHub", "Google"]);
			yield* sql`UPDATE "user" SET name = ${"\u{1F426}".repeat(80)} WHERE id = ${request.owner_id}`;
			yield* service.issue(request.owner_id, board.id);
			expect(sent[2]?.[0]?.label).toBe("\u{1F426}".repeat(50));
			expect(sent.length).toBe(3);
		}),
	);
});

test("open: one exec for a board in setup; a new image gets prefilled setup, an older one the code it issued", async () => {
	await runFresh(
		Effect.gen(function* () {
			const { board, provider, host, sql } = yield* provisioned;
			const offered: Array<ReadonlyArray<SetupIdentity>> = [];
			const open = (api: Parameters<typeof setupLayer>[1]) =>
				Effect.gen(function* () {
					const before = offered.length;
					const issue = api.issue;
					const result = yield* Effect.result(
						BoardSetup.use((service) => service.open(request.owner_id, board.id)).pipe(
							Effect.provide(
								setupLayer(provider, {
									...api,
									...(issue
										? {
												issue: (identities: ReadonlyArray<SetupIdentity>) =>
													Effect.suspend(() => {
														offered.push(identities);
														return issue(identities);
													}),
											}
										: {}),
								}),
							),
						),
					);
					return { result, execs: offered.length - before };
				});
			const newImage = (identities: ReadonlyArray<SetupIdentity>) => Effect.succeed(identities.length);
			const oldImage = () => Effect.succeed(undefined);
			const setupUrl = `https://${host}/setup#code=A1B2C3D4E5F60718`;
			const issuedFallback = { fallback: "setup_code", code: "A1B2C3D4E5F60718", expires_at: expect.any(String) };

			// No GitHub or Google account.
			expect(yield* open({ setupRequired: Effect.succeed(false) })).toEqual({
				result: Result.succeed({ url: `https://${host}/auth/login` }),
				execs: 0,
			});
			expect(yield* open({ setupRequired: Effect.succeed(true), issue: newImage })).toEqual({
				result: Result.succeed({ url: setupUrl }),
				execs: 1,
			});
			expect(offered.at(-1)).toEqual([]);
			expect(yield* open({ setupRequired: Effect.succeed(true), issue: oldImage })).toEqual({
				result: Result.succeed(issuedFallback),
				execs: 1,
			});

			yield* linkAccount(sql, "g", request.owner_id, "google", "109876543210", 0);
			expect(yield* open({ setupRequired: Effect.succeed(false) })).toMatchObject({
				result: { success: { url: `https://${host}/auth/login?provider=google&next=/` } },
				execs: 0,
			});
			yield* linkAccount(sql, "h", request.owner_id, "github", "583231", 10);
			expect(yield* open({ setupRequired: Effect.succeed(false) })).toMatchObject({
				result: { success: { url: `https://${host}/auth/login?provider=github&next=/` } },
				execs: 0,
			});
			expect(yield* open({ setupRequired: Effect.succeed(true), issue: newImage })).toEqual({
				result: Result.succeed({ url: setupUrl }),
				execs: 1,
			});
			expect(offered.at(-1)?.map((identity) => identity.subject)).toEqual(["github:583231", "google:109876543210"]);
			// A new image that linked nobody still prefills /setup; only a reply without the key is an older image.
			expect(yield* open({ setupRequired: Effect.succeed(true), issue: () => Effect.succeed(0) })).toEqual({
				result: Result.succeed({ url: setupUrl }),
				execs: 1,
			});
			expect(yield* open({ setupRequired: Effect.succeed(true), issue: oldImage })).toEqual({
				result: Result.succeed(issuedFallback),
				execs: 1,
			});
			// A passkey created between the state read and exec.
			expect(
				yield* open({
					setupRequired: Effect.succeed(true),
					issue: () => Effect.fail(new SetupCodeIssue({ code: "setup_closed" })),
				}),
			).toMatchObject({ result: { success: { url: `https://${host}/auth/login?provider=github&next=/` } }, execs: 1 });
			expect(
				yield* open({
					setupRequired: Effect.succeed(true),
					issue: () => Effect.fail(new SetupCodeIssue({ code: "setup_code_unsupported" })),
				}),
			).toEqual({ result: Result.succeed({ fallback: "setup_code" }), execs: 1 });
			expect(
				yield* open({ setupRequired: Effect.fail(new SetupCodeIssue({ code: "setup_code_unavailable" })) }),
			).toMatchObject({ result: { failure: { code: "setup_code_unavailable" } }, execs: 0 });
			yield* sql`UPDATE board_routes SET hostname = 'foreign.test' WHERE board_id = ${board.id}`;
			expect(yield* open({})).toMatchObject({ result: { failure: { code: "setup_code_unavailable" } }, execs: 0 });
		}),
	);
});
