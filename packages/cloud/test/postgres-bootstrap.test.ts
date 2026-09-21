import { Effect, Exit, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import {
	derivePostgresUrls,
	isAllowedPostgresAddress,
	isTransientPostgresFailure,
	validatePostgresUrl,
} from "../src/postgres-bootstrap.ts";

describe("Postgres bootstrap configuration", () => {
	test("refuses private, metadata, multicast and mapped addresses", () => {
		for (const address of [
			"0.0.0.0",
			"10.1.2.3",
			"100.100.100.200",
			"127.0.0.1",
			"169.254.169.254",
			"172.31.0.1",
			"192.168.1.1",
			"198.18.1.1",
			"224.0.0.1",
			"::1",
			"::ffff:127.0.0.1",
		])
			expect(isAllowedPostgresAddress(address)).toBe(false);
		expect(isAllowedPostgresAddress("8.8.8.8")).toBe(true);
		expect(isAllowedPostgresAddress("127.0.0.1", true)).toBe(true);
		expect(isAllowedPostgresAddress("169.254.169.254", true)).toBe(false);
	});
	test("rejects connection overrides, TLS downgrades and unsupported binding requirements", async () => {
		for (const query of [
			"sslmode=disable",
			"sslmode=no-verify",
			"host=127.0.0.1",
			"options=-cfoo",
			"sslmode=require&sslmode=disable",
			"channel_binding=require",
		]) {
			const exit = await Effect.runPromise(
				Effect.exit(validatePostgresUrl(Redacted.make(`postgres://user:password@db.example.com/db?${query}`))),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		}
	});
	test("derives isolated query-free credentials with verified TLS", async () => {
		const result = await Effect.runPromise(
			derivePostgresUrls({
				boardId: "01234567-89ab-cdef-0123-456789abcdef",
				adminUrl: Redacted.make("postgresql://admin:adminpw@db.example.com/admin?sslmode=require"),
				bootPassword: Redacted.make("a".repeat(64)),
				appPassword: Redacted.make("b".repeat(64)),
			}),
		);
		const boot = new URL(Redacted.value(result.bootUrl));
		const app = new URL(Redacted.value(result.appUrl));
		expect(boot.search).toBe("");
		expect(app.search).toBe("");
		expect(boot.username).toBe("chirp_0123456789abcdef0123456789abcdef_boot");
		expect(app.username).not.toBe(boot.username);
		expect(result.tls).toBe(true);
	});
	test("classifies only transient statement and connection failures for retry", () => {
		for (const code of ["08006", "40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53300", "ECONNRESET"])
			expect(isTransientPostgresFailure(Object.assign(new Error("failure"), { code }))).toBe(true);
		expect(isTransientPostgresFailure(new Error("Query read timeout"))).toBe(true);
		expect(isTransientPostgresFailure(Object.assign(new Error("permission denied"), { code: "42501" }))).toBe(false);
	});
});

import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { bootstrapPostgres } from "../src/postgres-bootstrap.ts";

const testUrl = process.env["POSTGRES_ADMIN_TEST_URL"];
test.skipIf(!testUrl)(
	"isolated PostgreSQL bootstrap authenticates, retries, and refuses foreign ownership markers",
	async () => {
		if (!testUrl) return;
		const admin = new Client({ connectionString: testUrl });
		await admin.connect();
		const localUrl = new URL(testUrl);
		localUrl.searchParams.set("sslmode", "disable");
		const input = {
			boardId: randomUUID(),
			adminUrl: Redacted.make(localUrl.toString()),
			allowLocal: true,
			bootPassword: Redacted.make(randomBytes(32).toString("hex")),
			appPassword: Redacted.make(randomBytes(32).toString("hex")),
		};
		const names = await Effect.runPromise(derivePostgresUrls(input));
		try {
			const first = await Effect.runPromise(bootstrapPostgres(input));
			const second = await Effect.runPromise(bootstrapPostgres(input));
			expect(Redacted.value(first.appUrl)).toBe(Redacted.value(second.appUrl));
			const checks = await admin.query<{ denied: boolean; owner: string }>(
				"SELECT NOT has_database_privilege($1, $2, 'CONNECT') AS denied, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
				[names.appName, names.bootName],
			);
			expect(checks.rows[0]).toEqual({ denied: true, owner: names.bootName });
			for (const connectionString of [Redacted.value(first.appUrl), Redacted.value(first.bootUrl)]) {
				const client = new Client({ connectionString });
				await client.connect();
				try {
					const schema = await client.query<{ owner: string }>(
						"SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'",
					);
					expect(schema.rows[0]?.owner).toBe(names.bootName);
					const role = await client.query<{ safe: boolean }>(
						"SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname=current_user",
					);
					expect(role.rows[0]?.safe).toBe(true);
				} finally {
					await client.end();
				}
			}
			const denied = new Client({
				connectionString: Redacted.value(first.appUrl).replace(`/${names.appName}`, `/${names.bootName}`),
			});
			try {
				await expect(denied.connect()).rejects.toThrow();
			} finally {
				await denied.end();
			}
			const foreign = await Effect.runPromise(
				Effect.exit(bootstrapPostgres({ ...input, bootPassword: Redacted.make(randomBytes(32).toString("hex")) })),
			);
			expect(Exit.isFailure(foreign)).toBe(true);
		} finally {
			for (const name of [names.appName, names.bootName]) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
			for (const name of [names.appName, names.bootName]) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
			await admin.end();
		}
	},
	30_000,
);
