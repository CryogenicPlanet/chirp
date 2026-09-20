import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Boards } from "../src/boards.ts";
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
		const board = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('runtime-owner', 'Owner', 'owner@example.com', true)`;
				yield* sql`INSERT INTO session (id, token, "userId", "expiresAt", "updatedAt")
				VALUES ('runtime-session', 'runtime-token', 'runtime-owner', now() + interval '1 hour', now())`;
				yield* sql`ALTER TABLE board_operations ALTER COLUMN available_at SET DEFAULT (now() + interval '1 day')`;
				const board = yield* (yield* Boards).request({
					owner_id: "runtime-owner",
					requested_by: "runtime-owner",
					name: "Runtime board",
					storage_engine: "sqlite",
					idempotency_key: "runtime-board",
				});
				return board;
			}),
		);
		const port = await availablePort();
		const publicOrigin = `http://localhost:${port}`;
		const signature = createHmac("sha256", "production-test-auth-secret-with-32-characters")
			.update("runtime-token")
			.digest("base64");
		const headers = { cookie: `better-auth.session_token=${encodeURIComponent(`runtime-token.${signature}`)}` };
		const monitor = new Pool({ connectionString: databaseUrl, max: 2 });
		const lock = await monitor.connect();
		const child = spawn(process.execPath, ["src/server.ts"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				NODE_ENV: "production",
				PORT: String(port),
				HOST: "0.0.0.0",
				CLOUD_DATABASE_URL: databaseUrl,
				BETTER_AUTH_URL: publicOrigin,
				BETTER_AUTH_SECRET: "production-test-auth-secret-with-32-characters",
				CLOUD_CLIENT_IP_HEADER: "fly-client-ip",
				GITHUB_CLIENT_ID: "github-client",
				GITHUB_CLIENT_SECRET: "github-secret",
				GOOGLE_CLIENT_ID: "google-client",
				GOOGLE_CLIENT_SECRET: "google-secret",
				FLY_API_TOKEN: "fly-token",
				CLOUDFLARE_API_TOKEN: "cloudflare-token",
				CLOUDFLARE_ZONE_ID: "a".repeat(32),
				FLY_ORGANIZATION: "chirp-test",
				FLY_REGION: "sjc",
				CHIRP_IMAGE: `registry.example/chirp@sha256:${"a".repeat(64)}`,
				BOARDS_DOMAIN: "boards.example.com",
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
				ready = await fetch(`http://127.0.0.1:${port}/`, {
					headers: { "fly-client-ip": "192.0.2.10" },
				}).then(
					(response) => response.status === 200,
					() => false,
				);
			}
			expect(ready, output).toBe(true);
			expect(
				(
					await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, {
						headers: { "fly-client-ip": "192.0.2.10" },
					})
				).status,
			).toBe(200);
			expect(
				await fetch(`http://[::1]:${port}/`, {
					headers: { "fly-client-ip": "203.0.113.1" },
				}).then(
					() => true,
					() => false,
				),
			).toBe(false);
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE verification IN ACCESS EXCLUSIVE MODE");
			const pending = Array.from({ length: 24 }, () =>
				fetch(`http://127.0.0.1:${port}/api/auth/passkey/generate-authenticate-options`, {
					headers: { "fly-client-ip": "192.0.2.10" },
				}),
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
			const cloudConnections = () =>
				monitor.query<{ readonly pid: number }>(
					"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud' ORDER BY pid",
				);
			const workerPids = new Set((await cloudConnections()).rows.map(({ pid }) => pid));
			const dashboard = (path = "/api/boards") => fetch(`http://127.0.0.1:${port}${path}`, { headers });
			const create = (origin: string, key: string) =>
				fetch(`http://127.0.0.1:${port}/api/boards`, {
					method: "POST",
					headers: { ...headers, origin, "content-type": "application/json", "idempotency-key": key },
					body: JSON.stringify({ name: "Created through the public origin" }),
				});
			const created = await create(publicOrigin, "public-origin-create");
			expect(created.status).toBe(201);
			expect(created.headers.get("cache-control")).toBe("no-store");
			expect(await created.json()).toMatchObject({ board: { name: "Created through the public origin" } });
			const rejectedOrigin = await create(`http://127.0.0.1:${port}`, "internal-origin-create");
			expect(rejectedOrigin.status).toBe(403);
			expect(await rejectedOrigin.json()).toEqual({ error: { code: "origin_rejected" } });
			const listed = await dashboard();
			expect(listed.status).toBe(200);
			expect(listed.headers.get("cache-control")).toBe("no-store");
			expect(await listed.json()).toMatchObject({
				boards: expect.arrayContaining([expect.objectContaining({ id: board.id })]),
			});
			expect((await monitor.query("SELECT id FROM boards")).rows).toHaveLength(2);
			const sharedPids = (await cloudConnections()).rows
				.filter(({ pid }) => !workerPids.has(pid))
				.map(({ pid }) => pid);
			expect(sharedPids.length).toBeGreaterThan(0);
			for (let attempt = 0; attempt < 4; attempt += 1)
				expect((await dashboard(`/api/boards/${board.id}`)).status).toBe(200);
			expect((await cloudConnections()).rows.map(({ pid }) => pid)).toEqual(expect.arrayContaining(sharedPids));
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE boards IN ACCESS EXCLUSIVE MODE");
			const dashboardPending = Array.from({ length: 24 }, (_, index) =>
				dashboard(index % 2 === 0 ? "/api/boards" : `/api/boards/${board.id}`),
			);
			let dashboardConnections = 0;
			for (let attempt = 0; attempt < 40 && dashboardConnections < 8; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				dashboardConnections = (await cloudConnections()).rows.filter(({ pid }) => !workerPids.has(pid)).length;
			}
			expect(dashboardConnections).toBe(8);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect((await cloudConnections()).rows.filter(({ pid }) => !workerPids.has(pid))).toHaveLength(8);
			await lock.query("ROLLBACK");
			expect((await Promise.all(dashboardPending)).every((response) => response.status === 200)).toBe(true);
			expect((await dashboard("/api/boards/not-a-uuid")).status).toBe(404);
			const signedOutPage = await fetch(`http://127.0.0.1:${port}/boards/${board.id}`);
			expect(await signedOutPage.text()).toContain("Sign in to view this board.");
			await monitor.query("ALTER TABLE session RENAME TO unavailable_session");
			try {
				const unavailablePage = await fetch(`http://127.0.0.1:${port}/boards/${board.id}`, { headers });
				const html = await unavailablePage.text();
				expect(html).toContain("Your session could not be checked.");
				expect(html).not.toContain("Sign in to view this board.");
			} finally {
				await monitor.query("ALTER TABLE unavailable_session RENAME TO session");
			}
			await lock.query("BEGIN");
			await lock.query("LOCK TABLE verification IN ACCESS EXCLUSIVE MODE");
			await lock.query("LOCK TABLE boards IN ACCESS EXCLUSIVE MODE");
			const inFlight = fetch(`http://127.0.0.1:${port}/api/auth/passkey/generate-authenticate-options`, {
				headers: { "fly-client-ip": "192.0.2.10" },
			});
			const dashboardInFlight = dashboard(`/api/boards/${board.id}`);
			let waiting = 0;
			for (let attempt = 0; attempt < 40 && waiting === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly waiting: string }>(
					"SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth' AND state = 'active' AND wait_event_type = 'Lock'",
				);
				waiting = Number(observed.rows[0]?.waiting);
			}
			expect(waiting).toBe(1);
			let dashboardWaiting = 0;
			for (let attempt = 0; attempt < 40 && dashboardWaiting === 0; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				const observed = await monitor.query<{ readonly pid: number }>(
					"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud' AND state = 'active' AND wait_event_type = 'Lock'",
				);
				dashboardWaiting = observed.rows.filter(({ pid }) => !workerPids.has(pid)).length;
			}
			expect(dashboardWaiting).toBe(1);
			const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
			child.kill("SIGTERM");
			const exitedBeforeRelease = await Promise.race([
				exit.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
			]);
			expect(exitedBeforeRelease).toBe(false);
			await lock.query("ROLLBACK");
			expect((await inFlight).status).toBe(200);
			expect((await dashboardInFlight).status).toBe(200);
			const exitCode = await exit;
			expect(exitCode, output).toBe(143);
			expect(output).toContain("Chirp Cloud authentication pool stopped");
			expect(output).toContain("Chirp Cloud stopped cleanly");
			const remaining = await monitor.query<{ readonly connections: string }>(
				"SELECT count(*) AS connections FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth'",
			);
			expect(Number(remaining.rows[0]?.connections)).toBe(0);
			expect((await cloudConnections()).rows).toEqual([]);
		} finally {
			await lock.query("ROLLBACK");
			lock.release();
			child.kill("SIGKILL");
			await monitor.end();
		}
	}, 30_000);
});
