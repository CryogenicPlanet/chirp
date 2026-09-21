import { Effect, Option, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PostgresStorage } from "../src/postgres-storage.ts";
import { FlySecrets, FlySecretsError } from "../src/fly-secrets.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { makeFakeProvider, nextClaim, provisionerFor } from "./fixtures/provisioner.ts";
import { Dashboard } from "../src/dashboard.ts";
import { Database } from "../src/database.ts";
import { CloudSecrets } from "../src/cloud-secrets.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { boardOperations, boardPostgresSecrets } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";

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
				const payload = Redacted.value(yield* (yield* CloudSecrets).decrypt(board.id, row.ciphertext));
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
			// Bootstrap DDL is verified by the isolated live-Postgres suite. Start at its durable checkpoint.
			const storage = yield* PostgresStorage;
			const prepared = {
				...storage,
				prepare: (boardId: string) =>
					database
						.update(boardPostgresSecrets)
						.set({ prepared: true })
						.where(eq(boardPostgresSecrets.board_id, boardId))
						.pipe(Effect.asVoid),
			};
			const run = Effect.gen(function* () {
				const provisioner = yield* Provisioner;
				expect(yield* provisioner.run(yield* nextClaim("worker"), "worker")).toBe("requeued");
				expect(provider.resources().machines).toBe(0);
				const row = (yield* database.select().from(boardPostgresSecrets))[0];
				expect(row?.prepared).toBe(true);
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
