import { Effect, Layer, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CloudAuthSettings } from "../src/auth-settings.ts";
import { CloudAuth, cloudAuthLayer } from "../src/cloud-auth.ts";
import { Invitations } from "../src/invitations.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { cryptoLayer, realPostgres, runFresh } from "./fixture.ts";
import { authenticator } from "./fixtures/authenticator.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL ?? "postgres://unused";
const settings: CloudAuthSettings = {
	databaseUrl: Redacted.make(databaseUrl),
	publicOrigin: "https://cloud.test",
	authSecret: Redacted.make("test-auth-secret-with-at-least-32-characters"),
	clientIpHeader: "fly-client-ip",
	githubClientId: "github-client",
	githubClientSecret: Redacted.make("github-secret"),
	googleClientId: "google-client",
	googleClientSecret: Redacted.make("google-secret"),
};

const authLayer = cloudAuthLayer(settings).pipe(Layer.provideMerge(cryptoLayer));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const handle = (request: Request) =>
	Effect.runPromise(CloudAuth.use((auth) => auth.handle(request)).pipe(Effect.provide(authLayer)));
const cookies = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";", 1)[0])
		.join("; ");

describe.skipIf(!realPostgres)("CloudAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("serves standard Requests and refuses unauthenticated or untrusted mutations", async () => {
		await runFresh(migrateCloudDatabase);
		const session = await handle(new Request("https://cloud.test/api/auth/get-session"));
		expect(session.status).toBe(200);
		expect(await session.json()).toBeNull();

		const registration = await handle(
			new Request("https://cloud.test/api/auth/passkey/generate-register-options", {
				headers: { origin: "https://cloud.test" },
			}),
		);
		expect(registration.status).toBe(401);

		const passwordSignup = await handle(
			new Request("https://cloud.test/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://cloud.test" },
				body: json({ email: "person@example.com", name: "Person", password: "not-enabled" }),
			}),
		);
		expect(passwordSignup.status).toBe(400);

		const untrusted = await handle(
			new Request("https://cloud.test/api/auth/sign-in/social", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://cloud.test" },
				body: json({ provider: "github", callbackURL: "https://evil.example" }),
			}),
		);
		expect(untrusted.status).toBe(403);
	});

	test("starts an explicit invited OAuth sign-up and preserves the response cookies", async () => {
		await runFresh(migrateCloudDatabase);
		const invitation = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
		const response = await handle(
			new Request("https://cloud.test/api/auth/sign-in/social", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://cloud.test" },
				body: json({
					provider: "github",
					callbackURL: "/",
					requestSignUp: true,
					additionalData: { invitation },
				}),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).not.toEqual([]);
		expect(await response.json()).toMatchObject({ redirect: true });
		const control = new Pool({ connectionString: databaseUrl });
		try {
			const stored = await control.query<{ readonly value: string }>("SELECT value FROM verification");
			expect(stored.rows.every((row) => !row.value.includes(invitation))).toBe(true);
		} finally {
			await control.end();
		}
	});

	test("completes invited GitHub signup and a signed passkey ceremony", async () => {
		const issued = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				return yield* (yield* Invitations).issue("person@example.com", 60_000);
			}),
		);
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
			if (url === "https://github.com/login/oauth/access_token")
				return Response.json({ access_token: "test-access-token", token_type: "bearer", scope: "user:email" });
			if (url === "https://api.github.com/user")
				return Response.json({
					id: "12345",
					name: "Test Person",
					login: "person",
					email: "person@example.com",
					avatar_url: "https://avatars.example/person",
				});
			if (url === "https://api.github.com/user/emails")
				return Response.json([{ email: "person@example.com", primary: true, verified: true }]);
			throw new Error(`Unexpected OAuth request: ${url}`);
		});
		const started = await handle(
			new Request("https://cloud.test/api/auth/sign-in/social", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://cloud.test" },
				body: json({
					provider: "github",
					callbackURL: "/",
					requestSignUp: true,
					additionalData: { invitation: issued.token },
				}),
			}),
		);
		const startBody = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await started.json());
		const state = new URL(startBody.url).searchParams.get("state");
		expect(state).not.toBeNull();
		const callback = await handle(
			new Request(`https://cloud.test/api/auth/callback/github?code=test-code&state=${state}`, {
				headers: { cookie: cookies(started) },
			}),
		);
		expect(callback.status).toBe(302);
		expect(callback.headers.get("location")).toBe("/");
		const sessionCookies = cookies(callback);
		const sessionCookie = callback.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("__Host-chirp-cloud.session_token="));
		expect(sessionCookie).toBeDefined();
		expect(sessionCookie).toContain("Path=/");
		expect(sessionCookie).toContain("Secure");
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).not.toContain("Domain=");
		const session = await handle(
			new Request("https://cloud.test/api/auth/get-session", { headers: { cookie: sessionCookies } }),
		);
		expect(session.status).toBe(200);
		expect(await session.json()).toMatchObject({ user: { email: "person@example.com" } });

		const key = authenticator();
		const registrationOptionsResponse = await handle(
			new Request("https://cloud.test/api/auth/passkey/generate-register-options", {
				headers: { cookie: sessionCookies, origin: "https://cloud.test" },
			}),
		);
		expect(registrationOptionsResponse.status).toBe(200);
		const registrationOptions = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
			await registrationOptionsResponse.json(),
		);
		const registered = await handle(
			new Request("https://cloud.test/api/auth/passkey/verify-registration", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `${sessionCookies}; ${cookies(registrationOptionsResponse)}`,
					origin: "https://cloud.test",
				},
				body: json({ response: key.registration(registrationOptions.challenge, "https://cloud.test", "cloud.test") }),
			}),
		);
		expect(registered.status).toBe(200);

		const authenticationOptionsResponse = await handle(
			new Request("https://cloud.test/api/auth/passkey/generate-authenticate-options"),
		);
		const authenticationOptions = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
			await authenticationOptionsResponse.json(),
		);
		const assertion = key.assertion(authenticationOptions.challenge, 1, "https://cloud.test", "cloud.test");
		const authenticate = () =>
			handle(
				new Request("https://cloud.test/api/auth/passkey/verify-authentication", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: cookies(authenticationOptionsResponse),
						origin: "https://cloud.test",
					},
					body: json({ response: assertion }),
				}),
			);
		expect(
			(await Promise.all([authenticate(), authenticate()]))
				.map((response) => response.status)
				.sort((left, right) => left - right),
		).toEqual([200, 400]);
		const wrongOriginOptionsResponse = await handle(
			new Request("https://cloud.test/api/auth/passkey/generate-authenticate-options"),
		);
		const wrongOriginOptions = Schema.decodeUnknownSync(Schema.Struct({ challenge: Schema.String }))(
			await wrongOriginOptionsResponse.json(),
		);
		const wrongOrigin = await handle(
			new Request("https://cloud.test/api/auth/passkey/verify-authentication", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: cookies(wrongOriginOptionsResponse),
					origin: "https://cloud.test",
				},
				body: json({ response: key.assertion(wrongOriginOptions.challenge, 2, "https://evil.example", "cloud.test") }),
			}),
		);
		expect(wrongOrigin.status).toBe(400);
		const crossOriginSignOut = await handle(
			new Request("https://cloud.test/api/auth/sign-out", {
				method: "POST",
				headers: { "content-type": "application/json", cookie: sessionCookies, origin: "https://evil.example" },
				body: json({}),
			}),
		);
		expect(crossOriginSignOut.status).toBe(403);
		const control = new Pool({ connectionString: databaseUrl });
		try {
			const counts = await control.query<{
				readonly users: string;
				readonly accounts: string;
				readonly invitations: string;
				readonly passkeys: string;
			}>(
				'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM account) AS accounts, (SELECT count(*) FROM cloud_invitations) AS invitations, (SELECT count(*) FROM passkey) AS passkeys',
			);
			expect(counts.rows[0]).toEqual({ users: "1", accounts: "1", invitations: "0", passkeys: "1" });
		} finally {
			await control.end();
		}
	});

	test("rate limits authoritative client IPs independently with a bounded retry interval", async () => {
		await runFresh(migrateCloudDatabase);
		const responses: Response[] = [];
		for (let attempt = 0; attempt < 4; attempt += 1)
			responses.push(
				await handle(
					new Request("https://cloud.test/api/auth/sign-in/social", {
						method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://cloud.test",
						"fly-client-ip": "192.0.2.1",
					},
						body: json({ provider: "github", callbackURL: "/" }),
					}),
				),
			);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
		expect(
			(
				await handle(
					new Request("https://cloud.test/api/auth/sign-in/social", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "https://cloud.test",
							"fly-client-ip": "198.51.100.2",
						},
						body: json({ provider: "github", callbackURL: "/" }),
					}),
				)
			).status,
		).toBe(200);
		const retryAfter = Number(responses[3]?.headers.get("x-retry-after"));
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(10);
	});

	test("recovers after PostgreSQL drops an idle authentication connection", async () => {
		await runFresh(migrateCloudDatabase);
		const control = new Pool({ connectionString: databaseUrl });
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const auth = yield* CloudAuth;
					expect((yield* auth.handle(new Request("https://cloud.test/api/auth/get-session"))).status).toBe(200);
					const backend = yield* Effect.promise(() =>
						control.query<{ readonly pid: number }>(
							"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'chirp-cloud-auth' ORDER BY backend_start DESC LIMIT 1",
						),
					);
					const pid = backend.rows[0]?.pid;
					expect(pid).toBeDefined();
					const terminated = yield* Effect.promise(() =>
						control.query<{ readonly terminated: boolean }>("SELECT pg_terminate_backend($1) AS terminated", [pid]),
					);
					expect(terminated.rows[0]?.terminated).toBe(true);
					yield* Effect.sleep("100 millis");
					expect((yield* auth.handle(new Request("https://cloud.test/api/auth/get-session"))).status).toBe(200);
				}).pipe(Effect.provide(authLayer)),
			);
		} finally {
			await control.end();
		}
	});
});
