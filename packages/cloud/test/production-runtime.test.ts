import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { realPostgres, runFresh } from "./fixture.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL ?? "postgres://unused";

const availablePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (!address || typeof address === "string") return reject(new Error("Unable to reserve a test port"));
			probe.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

describe.skipIf(!realPostgres)("production cloud runtime", () => {
	test("shares its bounded route pool and awaits disposal on shutdown", async () => {
		await runFresh(migrateCloudDatabase);
		const port = await availablePort();
		const monitor = new Pool({ connectionString: databaseUrl, max: 2 });
		const lock = await monitor.connect();
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				NODE_ENV: "production",
				PORT: String(port),
				HOST: "127.0.0.1",
				CLOUD_DATABASE_URL: databaseUrl,
				BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
				BETTER_AUTH_SECRET: "production-test-auth-secret-with-32-characters",
				CLOUD_CLIENT_IP_HEADER: "fly-client-ip",
				GITHUB_CLIENT_ID: "github-client",
				GITHUB_CLIENT_SECRET: "github-secret",
				GOOGLE_CLIENT_ID: "google-client",
				GOOGLE_CLIENT_SECRET: "google-secret",
				NEXT_TELEMETRY_DISABLED: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout?.on("data", (chunk: Uint8Array) => {
			output += Buffer.from(chunk).toString();
		});
		child.stderr?.on("data", (chunk: Uint8Array) => {
			output += Buffer.from(chunk).toString();
		});
		try {
			let ready = false;
			for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				ready = await fetch(`http://127.0.0.1:${port}/`).then(
					(response) => response.status === 200,
					() => false,
				);
			}
			expect(ready, output).toBe(true);
			expect((await fetch(`http://127.0.0.1:${port}/api/auth/get-session`)).status).toBe(200);
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE verification IN ACCESS EXCLUSIVE MODE");
			const pending = Array.from({ length: 24 }, () =>
				fetch(`http://127.0.0.1:${port}/api/auth/passkey/generate-authenticate-options`),
			);
			let connections = 0;
			for (let attempt = 0; attempt < 40 && connections < 8; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly connections: string }>(
					"SELECT count(*) AS connections FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth'",
				);
				connections = Number(observed.rows[0]?.connections);
			}
			expect(connections).toBe(8);
			await lock.query("ROLLBACK");
			expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE verification IN ACCESS EXCLUSIVE MODE");
			const inFlight = fetch(`http://127.0.0.1:${port}/api/auth/passkey/generate-authenticate-options`);
			let waiting = 0;
			for (let attempt = 0; attempt < 40 && waiting === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly waiting: string }>(
					"SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth' AND state = 'active' AND wait_event_type = 'Lock'",
				);
				waiting = Number(observed.rows[0]?.waiting);
			}
			expect(waiting).toBe(1);
			const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
			child.kill("SIGTERM");
			const exitedBeforeRelease = await Promise.race([
				exit.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
			]);
			expect(exitedBeforeRelease).toBe(false);
			await lock.query("ROLLBACK");
			expect((await inFlight).status).toBe(200);
			const exitCode = await exit;
			expect(exitCode, output).toBe(143);
			expect(output).toContain("Chirp Cloud authentication pool stopped");
			expect(output).toContain("Chirp Cloud stopped cleanly");
			const remaining = await monitor.query<{ readonly connections: string }>(
				"SELECT count(*) AS connections FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth'",
			);
			expect(Number(remaining.rows[0]?.connections)).toBe(0);
		} finally {
			await lock.query("ROLLBACK");
			lock.release();
			child.kill("SIGKILL");
			await monitor.end();
		}
	}, 30_000);
});
