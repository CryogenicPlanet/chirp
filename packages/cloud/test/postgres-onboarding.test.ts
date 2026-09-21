import { Effect, Option, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { PostgresStorage, postgresStorageLayerWithLocal } from "../src/postgres-storage.ts";
import { FlySecrets, FlySecretsError } from "../src/fly-secrets.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { makeFakeProvider, nextClaim, provisionerFor } from "./fixtures/provisioner.ts";
import { Dashboard } from "../src/dashboard.ts";
import { Database } from "../src/database.ts";
import { CloudSecrets } from "../src/cloud-secrets.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { PostgresBootstrapError } from "../src/postgres-bootstrap.ts";
import { boardOperations, boardPostgresSecrets } from "../src/schema.ts";
import { Boards } from "../src/boards.ts";
import { realPostgres, runFresh } from "./fixture.ts";

const url = "postgresql://admin:example-private-password@database.example.com/main?sslmode=require";
const input = {
	name: "Postgres board",
	storage_engine: "postgres",
	postgres_admin_url: url,
	idempotency_key: "create-pg",
} as const;

describe("Postgres onboarding persistence", () => {
	test("atomically stores encrypted credentials, replays without rotating, and conflicts on a changed URL", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const database = yield* Database;
				const board = yield* dashboard.create("owner", input);
				const rows = yield* database.select().from(boardPostgresSecrets);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.board_id).toBe(board.id);
				expect(JSON.stringify(rows)).not.toContain("example-private-password");
				expect(JSON.stringify(board)).not.toContain("admin");
				expect((yield* dashboard.list("owner")).capabilities.postgres).toBe(true);
				expect((yield* dashboard.create("owner", input)).id).toBe(board.id);
				expect(yield* database.select().from(boardPostgresSecrets)).toEqual(rows);
				const conflict = yield* dashboard
					.create("owner", { ...input, postgres_admin_url: url.replace("password", "changed") })
					.pipe(Effect.result);
				expect(conflict._tag).toBe("Failure");
				const operations = yield* database.select().from(boardOperations);
				expect(operations).toHaveLength(1);
				expect(JSON.stringify(operations)).not.toContain(url);
				const row = rows[0];
				if (!row) throw new Error("missing encrypted record");
				expect(row.runtime_ciphertext).toBe(null);
				if (!row.bootstrap_ciphertext) throw new Error("missing bootstrap credentials");
				const payload = Redacted.value(
					yield* (yield* CloudSecrets).decryptBootstrap(board.id, row.bootstrap_ciphertext),
				);
				expect(payload.adminUrl).toBe(url);
				expect(payload.bootPassword).not.toBe(payload.appPassword);
			}),
			Redacted.make("e".repeat(64)),
		);
	});
	test("rejects disabled capability and malformed/storage-inconsistent URLs without queueing", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				expect((yield* dashboard.list("owner")).capabilities.postgres).toBe(false);
				const result = yield* dashboard.create("owner", input).pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				expect(yield* (yield* Database).select().from(boardOperations)).toEqual([]);
			}),
		);
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				for (const postgres_admin_url of [
					"invalid",
					"postgres://user:private@127.0.0.1/postgres",
					`${url}&channel_binding=require`,
				]) {
					expect((yield* dashboard.create("owner", { ...input, postgres_admin_url }).pipe(Effect.result))._tag).toBe(
						"Failure",
					);
				}
				expect(
					(yield* dashboard.create("owner", { ...input, storage_engine: "sqlite" }).pipe(Effect.result))._tag,
				).toBe("Failure");
				expect(yield* (yield* Database).select().from(boardOperations)).toEqual([]);
			}),
			Redacted.make("f".repeat(64)),
		);
	});
});

test("retries secret upload durably and never leaks URLs to Machine configuration", async () => {
	const provider = makeFakeProvider();
	const created = vi.spyOn(provider.fake, "createMachine");
	let stageCalls = 0;
	const flySecrets = {
		ensure: (_app: string, secret: Redacted.Redacted<Record<string, string>>) =>
			Effect.gen(function* () {
				stageCalls += 1;
				const values = Redacted.value(secret);
				expect(Object.keys(values).sort()).toEqual(["BOOT_DATABASE_URL", "DATABASE_TLS", "DATABASE_URL"]);
				expect(values.DATABASE_URL).not.toContain("admin");
				expect(values.BOOT_DATABASE_URL).not.toEqual(values.DATABASE_URL);
				if (stageCalls === 1) return yield* new FlySecretsError({ reason: "transport", status: null });
				return 17;
			}),
	};
	await runFresh(
		Effect.gen(function* () {
			yield* migrateCloudDatabase;
			const board = yield* (yield* Dashboard).create("owner", input);
			const database = yield* Database;
			const cloudSecrets = yield* CloudSecrets;
			// Bootstrap DDL is verified by the isolated live-Postgres suite. Start at its durable checkpoint.
			const storage = yield* PostgresStorage;
			const prepared = {
				...storage,
				prepare: (boardId: string) =>
					Effect.gen(function* () {
						const runtimeCiphertext = yield* cloudSecrets.prepareRuntime(boardId, {
							bootUrl: "postgres://boot:boot-password@database.example/boot",
							appUrl: "postgres://app:app-password@database.example/app",
							tls: true,
						});
						yield* database
							.update(boardPostgresSecrets)
							.set({
								prepared: true,
								bootstrap_ciphertext: null,
								runtime_ciphertext: runtimeCiphertext,
							})
							.where(eq(boardPostgresSecrets.board_id, boardId));
						return undefined;
					}),
			};
			const run = Effect.gen(function* () {
				const provisioner = yield* Provisioner;
				expect(yield* provisioner.run(yield* nextClaim("worker"), "worker")).toBe("requeued");
				expect(provider.resources().machines).toBe(0);
				const row = (yield* database.select().from(boardPostgresSecrets))[0];
				expect(row?.prepared).toBe(true);
				expect(row?.bootstrap_ciphertext).toBe(null);
				expect(row?.runtime_ciphertext).not.toBe(null);
				expect(row?.fly_secrets_version).toBe(null);
				expect(yield* provisioner.run(yield* nextClaim("worker"), "worker")).toBe("succeeded");
				expect(stageCalls).toBe(2);
				expect(created).toHaveBeenCalledWith(expect.objectContaining({ minSecretsVersion: 17 }));
				expect(created.mock.calls[0]?.[0].config.env).toEqual(expect.objectContaining({ RP_ID: expect.any(String) }));
				expect(JSON.stringify(created.mock.calls)).not.toContain("DATABASE_URL");
				expect((yield* database.select().from(boardPostgresSecrets))[0]?.fly_secrets_version).toBe(17);
				expect(Option.getOrThrow(yield* (yield* Operations).latest(board.id, "provision")).state).toBe("succeeded");
			}).pipe(
				Effect.provide(provisionerFor(provider)),
				Effect.provideService(PostgresStorage, prepared),
				Effect.provideService(FlySecrets, flySecrets),
			);
			yield* run;
		}),
		Redacted.make("e".repeat(64)),
	);
});

test("retries app propagation misses but blocks definite Fly secret rejection", async () => {
	for (const [status, expected] of [
		[404, "requeued"],
		[401, "blocked"],
	] as const) {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Dashboard).create("owner", input);
				const database = yield* Database;
				const cloudSecrets = yield* CloudSecrets;
				const storage = yield* PostgresStorage;
				const prepared = {
					...storage,
					prepare: (boardId: string) =>
						Effect.gen(function* () {
							const runtimeCiphertext = yield* cloudSecrets.prepareRuntime(boardId, {
								bootUrl: "postgres://boot:boot-password@database.example/boot",
								appUrl: "postgres://app:app-password@database.example/app",
								tls: true,
							});
							yield* database
								.update(boardPostgresSecrets)
								.set({
									prepared: true,
									bootstrap_ciphertext: null,
									runtime_ciphertext: runtimeCiphertext,
								})
								.where(eq(boardPostgresSecrets.board_id, boardId));
							return undefined;
						}),
				};
				const operation = yield* nextClaim("worker");
				const outcome = yield* Provisioner.use((service) => service.run(operation, "worker")).pipe(
					Effect.provide(provisionerFor(provider)),
					Effect.provideService(PostgresStorage, prepared),
					Effect.provideService(FlySecrets, {
						ensure: () => Effect.fail(new FlySecretsError({ reason: "status", status })),
					}),
				);
				expect(outcome).toBe(expected);
				expect(provider.resources().machines).toBe(0);
				expect(Option.getOrThrow(yield* (yield* Operations).latest(board.id, "provision"))).toMatchObject({
					state: status === 404 ? "queued" : "failed",
					failure_count: status === 404 ? 1 : 0,
					last_error_code: "postgres_secrets_failed",
				});
			}),
			Redacted.make("e".repeat(64)),
		);
	}
});

test("retries transient PostgreSQL bootstrap failures and blocks permanent ones", async () => {
	for (const [reason, expected] of [
		["transient_failure", "requeued"],
		["bootstrap_failed", "blocked"],
	] as const) {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Dashboard).create("owner", { ...input, idempotency_key: `create-${reason}` });
				const storage = yield* PostgresStorage;
				const operation = yield* nextClaim(`worker-${reason}`);
				const outcome = yield* Provisioner.use((service) => service.run(operation, `worker-${reason}`)).pipe(
					Effect.provide(provisionerFor(provider)),
					Effect.provideService(PostgresStorage, {
						...storage,
						prepare: () => Effect.fail(new PostgresBootstrapError({ reason })),
					}),
				);
				expect(outcome).toBe(expected);
			}),
			Redacted.make("e".repeat(64)),
		);
	}
});

const adminTestUrl = process.env["POSTGRES_ADMIN_TEST_URL"];
test.skipIf(!adminTestUrl || !realPostgres)(
	"purges the database administrator credential at the fenced bootstrap checkpoint",
	async () => {
		if (!adminTestUrl) return;
		const localUrl = new URL(adminTestUrl);
		localUrl.searchParams.set("sslmode", "disable");
		let names: { readonly boot: string; readonly app: string } | undefined;
		try {
			names = await runFresh(
				Effect.gen(function* () {
					yield* migrateCloudDatabase;
					const board = yield* (yield* Boards).request({
						owner_id: "owner",
						name: "Live Postgres board",
						storage_engine: "postgres",
						postgres_admin_url: Redacted.make(localUrl.toString()),
						requested_by: "owner",
						idempotency_key: "live-postgres",
					});
					const operations = yield* Operations;
					const operation = Option.getOrThrow(yield* operations.claim("bootstrap-worker", 90_000, "provision"));
					if (!operation.lease_token) throw new Error("missing bootstrap lease");
					const storage = yield* PostgresStorage;
					const lease = {
						operationId: operation.id,
						leaseToken: operation.lease_token,
						workerId: "bootstrap-worker",
					};
					yield* storage.prepare(board.id, lease);
					yield* storage.prepare(board.id, lease);
					const row = (yield* (yield* Database).select().from(boardPostgresSecrets))[0];
					expect(row).toMatchObject({ prepared: true, bootstrap_ciphertext: null });
					if (!row?.runtime_ciphertext) throw new Error("missing runtime credentials");
					const payload = Redacted.value(yield* (yield* CloudSecrets).decryptRuntime(board.id, row.runtime_ciphertext));
					const generated = {
						boot: new URL(payload.bootUrl).username,
						app: new URL(payload.appUrl).username,
					};
					names = generated;
					for (const runtimeUrl of [payload.bootUrl, payload.appUrl]) {
						const parsed = new URL(runtimeUrl);
						expect(parsed.username).not.toBe(localUrl.username);
						expect(parsed.password).not.toBe(localUrl.password);
					}
					return generated;
				}).pipe(Effect.provide(postgresStorageLayerWithLocal(true))),
				Redacted.make("e".repeat(64)),
			);
		} finally {
			if (names) {
				const admin = new Client({ connectionString: adminTestUrl });
				await admin.connect();
				try {
					for (const name of [names.app, names.boot]) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
					for (const name of [names.app, names.boot]) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
				} finally {
					await admin.end();
				}
			}
		}
	},
	30_000,
);
