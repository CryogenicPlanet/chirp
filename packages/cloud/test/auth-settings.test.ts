import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { cloudAuthSettings } from "../src/auth-settings.ts";

const environment = {
	CLOUD_DATABASE_URL: "postgres://cloud:secret@db.example/cloud",
	BETTER_AUTH_URL: "https://cloud.chirp.wiki",
	BETTER_AUTH_SECRET: "a-secure-auth-secret-with-32-characters",
	CLOUD_CLIENT_IP_HEADER: "fly-client-ip",
	GITHUB_CLIENT_ID: "github-client",
	GITHUB_CLIENT_SECRET: "github-secret",
	GOOGLE_CLIENT_ID: "google-client",
	GOOGLE_CLIENT_SECRET: "google-secret",
};

const load = (values: Readonly<Record<string, string>>) =>
	cloudAuthSettings.pipe(
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
		Effect.runPromiseExit,
	);

describe("cloud auth settings", () => {
	test("loads the exact public origin and keeps credentials redacted", async () => {
		const result = await load(environment);
		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result)) {
			expect(result.value.publicOrigin).toBe("https://cloud.chirp.wiki");
			expect(Redacted.value(result.value.databaseUrl)).toBe(environment.CLOUD_DATABASE_URL);
		}
	});

	test("rejects a URL path and weak signing secrets", async () => {
		expect(Exit.isFailure(await load({ ...environment, BETTER_AUTH_URL: "https://cloud.chirp.wiki/auth" }))).toBe(true);
		expect(Exit.isFailure(await load({ ...environment, BETTER_AUTH_SECRET: "short" }))).toBe(true);
		expect(Exit.isFailure(await load({ ...environment, BETTER_AUTH_SECRET: "a".repeat(64) }))).toBe(true);
	});

	test("rejects insecure public origins and non-PostgreSQL control-plane stores", async () => {
		expect(Exit.isFailure(await load({ ...environment, BETTER_AUTH_URL: "http://cloud.chirp.wiki" }))).toBe(true);
		expect(
			Exit.isFailure(await load({ ...environment, CLOUD_DATABASE_URL: "mysql://cloud:secret@db.example/cloud" })),
		).toBe(true);
	});

	test("rejects an invalid authoritative client IP header", async () => {
		expect(Exit.isFailure(await load({ ...environment, CLOUD_CLIENT_IP_HEADER: "fly-client-ip, x-forwarded-for" }))).toBe(
			true,
		);
	});
});
