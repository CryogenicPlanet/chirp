import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cloudInvitation } from "../src/auth-schema.ts";
import { Database } from "../src/database.ts";
import { CloudAuth, cloudAuthLayer } from "../src/cloud-auth.ts";
import { Invitations } from "../src/invitations.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { cryptoLayer, realPostgres, runFresh } from "./fixture.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL ?? "postgres://unused";
const authLayer = cloudAuthLayer({
	databaseUrl: Redacted.make(databaseUrl),
	publicOrigin: "https://cloud.test",
	authSecret: Redacted.make("test-auth-secret-with-at-least-32-characters"),
	clientIpHeader: "fly-client-ip",
	github: { clientId: "github-client", clientSecret: Redacted.make("github-secret") },
	google: undefined,
}).pipe(Layer.provideMerge(cryptoLayer));
const handle = (request: Request) => {
	request.headers.set("fly-client-ip", "192.0.2.55");
	return Effect.runPromise(CloudAuth.use((auth) => auth.handle(request)).pipe(Effect.provide(authLayer)));
};
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cookies = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";", 1)[0])
		.join("; ");

const mockGithub = () =>
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
		if (url === "https://github.com/login/oauth/access_token") {
			const body = init?.body;
			if (!(typeof body === "string" || body instanceof URLSearchParams))
				throw new Error("Unexpected token request body");
			const code = new URLSearchParams(body).get("code");
			return Response.json({ access_token: code, token_type: "bearer", scope: "user:email" });
		}
		const account = new Headers(init?.headers).get("authorization")?.replace(/^bearer /i, "");
		const email = `${account}@example.com`;
		if (url === "https://api.github.com/user")
			return Response.json({ id: account, name: account, login: account, email });
		if (url === "https://api.github.com/user/emails")
			return Response.json([{ email, primary: true, verified: account !== "unverified" }]);
		throw new Error(`Unexpected OAuth endpoint: ${url}`);
	});

const start = async (token: string) => {
	const response = await handle(
		new Request("https://cloud.test/api/auth/sign-in/social", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://cloud.test" },
			body: json({ provider: "github", callbackURL: "/", requestSignUp: true, additionalData: { invitation: token } }),
		}),
	);
	expect(response.status).toBe(200);
	const body = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }))(await response.json());
	const state = new URL(body.url).searchParams.get("state");
	expect(state).not.toBeNull();
	return { state, cookies: cookies(response) };
};
const finish = (started: Awaited<ReturnType<typeof start>>, account: string) =>
	handle(
		new Request(`https://cloud.test/api/auth/callback/github?code=${account}&state=${started.state}`, {
			headers: { cookie: started.cookies },
		}),
	);
const counts = async () => {
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		return (
			await pool.query<{ users: string; invitations: string }>(
				'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM cloud_invitations) AS invitations',
			)
		).rows[0];
	} finally {
		await pool.end();
	}
};

describe.skipIf(!realPostgres)("generic invitation OAuth", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("admits either verified email but only one concurrent redemption", async () => {
		const issued = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				return yield* (yield* Invitations).issue(null, 60_000);
			}),
		);
		mockGithub();
		const first = await start(issued.token);
		const second = await start(issued.token);
		const responses = await Promise.all([finish(first, "alice"), finish(second, "bob")]);
		expect(responses.filter((response) => response.headers.get("location") === "/")).toHaveLength(1);
		expect(
			responses.filter((response) => response.headers.get("location")?.includes("invitation_invalid")),
		).toHaveLength(1);
		expect(await counts()).toEqual({ users: "1", invitations: "0" });
	});

	test("keeps existing email-bound links bound without consuming an unrelated generic invitation", async () => {
		const bound = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				yield* invitations.issue(null, 60_000);
				return yield* invitations.issue("alice@example.com", 60_000);
			}),
		);
		mockGithub();
		const rejected = await finish(await start(bound.token), "bob");
		expect(rejected.headers.get("location")).toContain("invitation_invalid");
		expect(await counts()).toEqual({ users: "0", invitations: "2" });
		const accepted = await finish(await start(bound.token), "alice");
		expect(accepted.headers.get("location")).toBe("/");
		expect(await counts()).toEqual({ users: "1", invitations: "1" });
	});

	test("does not consume a generic invitation for an unverified OAuth email", async () => {
		const issued = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				return yield* (yield* Invitations).issue(null, 60_000);
			}),
		);
		mockGithub();
		const rejected = await finish(await start(issued.token), "unverified");
		expect(rejected.headers.get("location")).not.toBe("/");
		expect(await counts()).toEqual({ users: "0", invitations: "1" });
	});

	test("retains digest and expiry constraints for generic invitations", async () => {
		const expired = await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				yield* invitations.issue(null, 60_000);
				const issued = yield* invitations.issue(null, 60_000);
				const database = yield* Database;
				yield* database
					.update(cloudInvitation)
					.set({ expires_at: new Date(0) })
					.where(eq(cloudInvitation.id, issued.invitation.id));
				return issued;
			}),
		);
		mockGithub();
		for (const token of [expired.token, "x".repeat(43)]) {
			const rejected = await finish(await start(token), "bob");
			expect(rejected.headers.get("location")).toContain("invitation_invalid");
		}
		expect(await counts()).toEqual({ users: "0", invitations: "2" });
	});
});
