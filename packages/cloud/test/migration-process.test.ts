import { spawn } from "node:child_process";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { realPostgres, runFresh } from "./fixture.ts";

const migrate = (mode: "older" | "compatible" | "incompatible" | "crash") =>
	Effect.promise(
		() =>
			new Promise<{ readonly code: number | null; readonly signal: string | null; readonly output: string }>(
				(resolve, reject) => {
					const child = spawn("bun", [new URL("./fixtures/migration-process.ts", import.meta.url).pathname, mode], {
						env: { ...process.env, CLOUD_DATABASE_URL: process.env.CLOUD_TEST_DATABASE_URL },
						stdio: ["ignore", "pipe", "pipe"],
					});
					let output = "";
					const deadline = setTimeout(() => {
						child.kill("SIGKILL");
						reject(new Error(`Migration process timed out: ${output}`));
					}, 10_000);
					child.stdout.on("data", (chunk: Uint8Array) => {
						output += Buffer.from(chunk).toString();
						if (mode === "crash" && output.includes("uncommitted-ddl")) child.kill("SIGKILL");
					});
					child.stderr.on("data", (chunk: Uint8Array) => {
						output += Buffer.from(chunk).toString();
					});
					child.once("error", (error) => {
						clearTimeout(deadline);
						reject(error);
					});
					child.once("close", (code, signal) => {
						clearTimeout(deadline);
						resolve({ code, signal, output });
					});
				},
			),
	);

describe.skipIf(!realPostgres)("Cloud migration process lifecycle", () => {
	test("prepares a fresh database, restarts, and rolls an image backward and forward without losing data", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const fresh = yield* migrate("older");
				expect(fresh.code, fresh.output).toBe(0);
				expect(fresh.output).toContain("schema-ready");
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
					VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'Retained', ${"a".repeat(32)}, 'sqlite')`;
				for (const mode of ["older", "compatible", "older", "compatible"] as const) {
					const restarted = yield* migrate(mode);
					expect(restarted.code, restarted.output).toBe(0);
				}
				expect(yield* sql`SELECT name, description FROM boards`).toEqual([{ name: "Retained", description: null }]);
				expect(yield* sql`SELECT migration_id FROM cloud_migrations ORDER BY migration_id`).toEqual([
					{ migration_id: 1 },
					{ migration_id: 2 },
				]);
			}),
		);
	});

	test("does not signal readiness when a newer incompatible image has migrated the database", async () => {
		await runFresh(
			Effect.gen(function* () {
				const newer = yield* migrate("incompatible");
				expect(newer.code, newer.output).toBe(0);
				const older = yield* migrate("older");
				expect(older.code, older.output).toBe(1);
				expect(older.output).not.toContain("schema-ready");
				expect(older.output).toContain(
					"Cloud schema 1: newer migration 2 does not explicitly declare this image compatible",
				);
			}),
		);
	});

	test("rolls uncommitted DDL back after process death and releases the migration lock for a clean restart", async () => {
		await runFresh(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const fresh = yield* migrate("older");
				expect(fresh.code, fresh.output).toBe(0);
				const before = yield* sql`SELECT * FROM cloud_migrations`;
				const crashed = yield* migrate("crash");
				expect(crashed.signal, crashed.output).toBe("SIGKILL");
				expect(crashed.output).not.toContain("schema-ready");
				const restarted = yield* migrate("older");
				expect(restarted.code, restarted.output).toBe(0);
				expect(yield* sql`SELECT * FROM cloud_migrations`).toEqual(before);
				const upgraded = yield* migrate("compatible");
				expect(upgraded.code, upgraded.output).toBe(0);
			}),
		);
	});
});
