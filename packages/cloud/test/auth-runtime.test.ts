import { Effect, Redacted } from "effect";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { makeAuthRequestRuntime } from "../src/auth-runtime.ts";
import type { CloudAuthSettings } from "../src/auth-settings.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { realPostgres, runFresh } from "./fixture.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL ?? "postgres://unused";
const settings: CloudAuthSettings = {
	databaseUrl: Redacted.make(databaseUrl),
	publicOrigin: "https://cloud.test",
	authSecret: Redacted.make("test-auth-secret-with-at-least-32-characters"),
	githubClientId: "github-client",
	githubClientSecret: Redacted.make("github-secret"),
	googleClientId: "google-client",
	googleClientSecret: Redacted.make("google-secret"),
};

describe.skipIf(!realPostgres)("authentication request runtime", () => {
	test("bounds concurrent requests to one application pool and disposes it", async () => {
		await runFresh(migrateCloudDatabase);
		const runtime = makeAuthRequestRuntime(Effect.succeed(settings));
		const monitor = new Pool({ connectionString: databaseUrl, max: 2 });
		const lock = await monitor.connect();
		try {
			expect((await runtime.handle(new Request("https://cloud.test/api/auth/get-session"))).status).toBe(200);
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE verification IN ACCESS EXCLUSIVE MODE");
			const pending = Array.from({ length: 24 }, () =>
				runtime.handle(new Request("https://cloud.test/api/auth/passkey/generate-authenticate-options")),
			);
			let connections = 0;
			for (let attempt = 0; attempt < 20 && connections < 8; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly connections: string }>(
					"SELECT count(*) AS connections FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth'",
				);
				connections = Number(observed.rows[0]?.connections);
			}
			expect(connections).toBe(8);
			await lock.query("ROLLBACK");
			expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
		} finally {
			await lock.query("ROLLBACK");
			lock.release();
			await runtime.dispose();
			let remaining = 1;
			for (let attempt = 0; attempt < 20 && remaining > 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly connections: string }>(
					"SELECT count(*) AS connections FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth'",
				);
				remaining = Number(observed.rows[0]?.connections);
			}
			expect(remaining).toBe(0);
			await monitor.end();
		}
	}, 10_000);
});
