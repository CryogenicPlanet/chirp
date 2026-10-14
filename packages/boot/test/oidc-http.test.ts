/* oxlint-disable effecttsgo/node-builtin-import */
import { assertionHeader, grantExtensionHeader, grantHeader } from "@comms/protocol/headers";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { authenticator } from "./fixtures/authenticator.ts";
import { fakeIssuer, type Grant } from "./fixtures/oidc-issuer.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const failure = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });
const started = Schema.Struct({ authorization_url: Schema.String });
const identities = Schema.Struct({
	identities: Schema.Array(Schema.Struct({ id: Schema.String, provider: Schema.String, label: Schema.String })),
	pending: Schema.NullOr(Schema.Struct({ id: Schema.String, label: Schema.String })),
	providers: Schema.Array(Schema.String),
});
const origin = "https://comms.test";
const octocat: Grant = { subject: "github:583231", provider: "github", label: "octocat" };

/** One boot process on a data directory that outlives it. */
const launch = async (test: TestContext, directory: string, issuer: string) => {
	const processHandle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: {
			...process.env,
			ENTRY: join(directory, "seed", "child.ts"),
			DATA_DIR: join(directory, "data"),
			OIDC_ISSUER: issuer,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (bytes: Buffer) => {
		output = (output + bytes.toString()).slice(-32768);
	};
	processHandle.stdout.on("data", capture);
	processHandle.stderr.on("data", capture);
	const stop = async () => {
		if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
		const exited = once(processHandle, "exit");
		processHandle.kill("SIGTERM");
		await Promise.race([exited, delay(5000)]);
		if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
		await exited;
	};
	test.onTestFinished(stop);
	let url = "";
	await expect
		.poll(() => {
			url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? "";
			return url;
		})
		.not.toBe("");
	// Authentication answers once boot has opened its store; the app itself never starts here.
	await expect.poll(async () => (await fetch(`${url}/_boot/auth/state`)).status).toBe(200);
	return { url, stop, output: () => output };
};

it("links, signs in with and unlinks a GitHub identity through a loopback issuer, across a real restart", async (test) => {
	const issuer = await fakeIssuer();
	test.onTestFinished(() => issuer.close());
	const directory = await mkdtemp(join(tmpdir(), "comms-oidc-http-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "seed"));
	await writeFile(join(directory, "seed", "child.ts"), 'throw new Error("intentionally unavailable app");');
	let board = await launch(test, directory, issuer.issuer);
	const request = (
		path: string,
		input: unknown,
		options: {
			readonly cookie?: string;
			readonly origin?: string | null;
			readonly method?: string;
			readonly headers?: Readonly<Record<string, string>>;
		} = {},
	) =>
		fetch(`${board.url}${path}`, {
			method: options.method ?? "POST",
			headers: {
				"content-type": "application/json",
				...(options.origin === null ? {} : { origin: options.origin ?? origin }),
				...(options.cookie === undefined ? {} : { cookie: options.cookie }),
				...options.headers,
			},
			body: JSON.stringify(input),
		});
	const read = (path: string, cookie: string, headers: Readonly<Record<string, string>> = {}) =>
		fetch(`${board.url}${path}`, { headers: { cookie, ...headers } });
	const errorCode = async (response: Response) => Schema.decodeUnknownSync(failure)(await response.json()).error.code;
	const cookieNamed = (response: Response, name: string) =>
		response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`)) ?? "";

	// A passkey comes first.
	const device = authenticator();
	const counter = { value: 0 };
	await expect.poll(async () => (await fetch(`${board.url}/setup`)).status).toBe(200);
	const setupCode = /\/setup is open, code ([A-F0-9]+)/.exec(board.output())?.[1];
	expect(setupCode).toBeTruthy();
	const setup = Schema.decodeUnknownSync(ceremony)(
		await (await request("/_boot/auth/setup/options", { code: setupCode })).json(),
	);
	expect(
		(
			await request("/_boot/auth/setup/verify", {
				id: setup.id,
				response: device.registration(setup.options.challenge),
			})
		).status,
	).toBe(200);
	const passkeySession = async () => {
		const login = Schema.decodeUnknownSync(ceremony)(await (await request("/_boot/auth/login/options", {})).json());
		const verified = await request("/_boot/auth/login/verify", {
			id: login.id,
			response: device.assertion(login.options.challenge, ++counter.value),
		});
		expect(verified.status).toBe(200);
		return cookieNamed(verified, "__Host-comms_session").split(";")[0] ?? "";
	};
	const proof = async (action: string, params: unknown, cookie: string) => {
		const response = await request("/_boot/auth/challenge", { action, params }, { cookie });
		expect(response.status).toBe(200);
		const challenge = Schema.decodeUnknownSync(ceremony)(await response.json());
		return Buffer.from(
			JSON.stringify({ id: challenge.id, response: device.assertion(challenge.options.challenge, ++counter.value) }),
		).toString("base64url");
	};
	/** Start, let the issuer approve, and follow the callback as the browser would: the issuer's redirect is
	 * cross-site, so only the Lax binding cookie comes along, never the Strict session cookie. */
	const roundTrip = async (input: unknown, cookie?: string, grant = octocat) => {
		const start = await request("/_boot/auth/oidc/start", input, cookie === undefined ? {} : { cookie });
		expect(start.status).toBe(200);
		const binding = cookieNamed(start, "__Host-chirp_oidc");
		for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) expect(binding).toContain(flag);
		const issued = issuer.issue(Schema.decodeUnknownSync(started)(await start.json()).authorization_url, grant);
		const callback = new URL(issued.callback);
		expect(callback.origin + callback.pathname).toBe(`${origin}/auth/oidc/callback`);
		const follow = () =>
			fetch(`${board.url}${callback.pathname}${callback.search}`, {
				headers: { cookie: binding.split(";")[0] ?? "", accept: "text/html" },
				redirect: "manual",
			});
		return { issued, follow };
	};

	const client = await fetch(`${board.url}/auth/oidc/client.json`);
	expect(await client.json()).toEqual({
		client_id: `${origin}/auth/oidc/client.json`,
		client_name: "comms.test",
		redirect_uris: [`${origin}/auth/oidc/callback`],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	});

	// Link: the callback holds the identity until this session confirms it with the passkey.
	const owner = await passkeySession();
	const linking = await roundTrip({ intent: "link", provider: "github" }, owner);
	expect(linking.issued.provider).toBe("github");
	expect(linking.issued.clientId).toBe(`${origin}/auth/oidc/client.json`);
	const linkPage = await linking.follow();
	expect(linkPage.status).toBe(200);
	expect(linkPage.headers.get("location")).toBeNull();
	expect(linkPage.headers.get("content-security-policy")).toContain("default-src 'none'");
	expect(linkPage.headers.get("referrer-policy")).toBe("no-referrer");
	expect(cookieNamed(linkPage, "__Host-chirp_oidc")).toContain("Max-Age=0");
	expect(cookieNamed(linkPage, "__Host-comms_session")).toBe("");
	const html = await linkPage.text();
	const pendingId = /content="0;url=\/@rahul\?link=([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
	expect(pendingId).toBeTruthy();
	const listed = Schema.decodeUnknownSync(identities)(await (await read("/_boot/auth/identities", owner)).json());
	expect(listed).toEqual({
		identities: [],
		pending: { ...listed.pending, id: pendingId, label: "octocat" },
		providers: ["github", "google"],
	});
	// The pending link needs the passkey: no proof, no Origin, a bearer, or a grant all refuse.
	expect(await errorCode(await request("/_boot/auth/identities", { pending: pendingId }, { cookie: owner }))).toBe(
		"assertion_invalid",
	);
	expect(
		(await request("/_boot/auth/identities", { pending: pendingId }, { cookie: owner, origin: null })).status,
	).toBe(403);
	const bearer = { authorization: `Bearer ${"a".repeat(43)}` };
	expect((await request("/_boot/auth/identities", { pending: pendingId }, { headers: bearer })).status).toBe(401);
	expect((await request("/_boot/auth/oidc/start", { intent: "link" }, { cookie: owner, headers: bearer })).status).toBe(
		401,
	);
	expect((await read("/_boot/auth/identities", owner, bearer)).status).toBe(401);
	const grant = { [grantHeader]: `f_${"a".repeat(43)}`, [grantExtensionHeader]: "mcp" };
	for (const path of ["/_boot/auth/identities", "/_boot/auth/oidc/start", "/auth/oidc/callback"])
		expect(await errorCode(await fetch(`${board.url}${path}`, { headers: grant }))).toBe("grant_forbidden");
	const linked = await request(
		"/_boot/auth/identities",
		{ pending: pendingId },
		{ cookie: owner, headers: { [assertionHeader]: await proof("identity.link", { id: pendingId }, owner) } },
	);
	expect(linked.status).toBe(200);
	expect(await linked.json()).toMatchObject({ provider: "github", label: "octocat", active: true });
	expect((await request("/_boot/auth/logout", {}, { cookie: owner })).status).toBe(204);

	// Sign in: the login page now offers GitHub, and the callback opens an ordinary session for the requested page.
	const loginPage = await (await fetch(`${board.url}/auth/login`)).text();
	expect(loginPage).toContain('data-provider="github"');
	expect(loginPage).not.toContain('data-provider="google"');
	expect((await request("/_boot/auth/oidc/start", { intent: "login" }, { origin: null })).status).toBe(403);
	expect((await request("/_boot/auth/oidc/start", { intent: "login" }, { origin: "https://evil.test" })).status).toBe(
		403,
	);
	expect(await errorCode(await request("/_boot/auth/oidc/start", { intent: "link" }))).toBe("session_invalid");
	const signingIn = await roundTrip({ intent: "login", provider: "github", next: "/t/design" });
	const signedIn = await signingIn.follow();
	expect(signedIn.status).toBe(200);
	expect(await signedIn.text()).toContain('content="0;url=/t/design"');
	const sessionHeader = cookieNamed(signedIn, "__Host-comms_session");
	for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(sessionHeader).toContain(flag);
	const github = sessionHeader.split(";")[0] ?? "";
	// The same callback cannot be replayed.
	expect((await signingIn.follow()).status).toBe(401);

	// The GitHub session has a passkey session's rights on session-only routes ...
	for (const path of ["/_boot/auth/passkeys", "/_boot/tokens", "/_boot/auth/identities", "/_boot/status"])
		expect((await read(path, github)).status).toBe(200);
	// ... and everything that needs a fresh passkey assertion still refuses without one.
	const identityId = Schema.decodeUnknownSync(identities)(await (await read("/_boot/auth/identities", github)).json())
		.identities[0]?.id;
	expect(identityId).toMatch(/^[a-f0-9]{64}$/);
	for (const [method, path, input] of [
		["POST", "/_boot/tokens", { agent: "dot", label: "laptop", scopes: ["read"], long_lived: false }],
		["POST", "/_boot/restart", {}],
		[
			"POST",
			"/_boot/settings",
			{ revision: 0, patch: { storage: { backup_percent: 20, event_percent: 10, headroom_percent: 5 } } },
		],
		["POST", "/_boot/auth/passkey-code", {}],
		["DELETE", `/_boot/auth/passkeys/${device.id}`, {}],
		["POST", `/_boot/tokens/f_${"a".repeat(43)}/revoke`, {}],
		["POST", "/_boot/db/restore", { backup: "b_missing" }],
		["DELETE", `/_boot/auth/identities/${identityId}`, {}],
	] as const) {
		const refused = await request(path, input, { cookie: github, method });
		expect([path, refused.status, await errorCode(refused)]).toEqual([path, 401, "assertion_invalid"]);
	}
	// Request diagnostics keep the callback's parameter names but never its code or state.
	let events = "";
	await expect
		.poll(async () => {
			events = JSON.stringify(await (await read("/_boot/events?limit=200", github)).json());
			return events.includes("/auth/oidc/callback");
		})
		.toBe(true);
	expect(events).not.toContain(signingIn.issued.code);
	expect(events).not.toContain(signingIn.issued.state);

	// A real restart: a sign-in started before it finishes after it, through a link that survived.
	const beforeRestart = await roundTrip({ intent: "login" });
	await board.stop();
	board = await launch(test, directory, issuer.issuer);
	const resumed = await beforeRestart.follow();
	expect(resumed.status).toBe(200);
	const resumedSession = cookieNamed(resumed, "__Host-comms_session").split(";")[0] ?? "";
	expect((await read("/_boot/auth/passkeys", resumedSession)).status).toBe(200);
	expect((await read("/_boot/auth/passkeys", github)).status).toBe(200);

	// Unlink with the passkey: every other session ends, and the identity no longer signs in.
	const passkey = await passkeySession();
	expect(
		(
			await request(
				`/_boot/auth/identities/${identityId}`,
				{},
				{ cookie: resumedSession, method: "DELETE", origin: null },
			)
		).status,
	).toBe(403);
	const unlinked = await request(
		`/_boot/auth/identities/${identityId}`,
		{},
		{
			cookie: resumedSession,
			method: "DELETE",
			headers: { [assertionHeader]: await proof("identity.unlink", { id: identityId }, resumedSession) },
		},
	);
	expect(unlinked.status).toBe(200);
	expect((await read("/_boot/auth/passkeys", resumedSession)).status).toBe(200);
	for (const ended of [passkey, github]) expect((await read("/_boot/auth/passkeys", ended)).status).toBe(401);
	expect(await (await fetch(`${board.url}/auth/login`)).text()).not.toContain("data-provider");
	const refusedLogin = await (await roundTrip({ intent: "login" })).follow();
	expect(refusedLogin.status).toBe(403);
	expect(await refusedLogin.text()).toContain("not linked");
	expect(cookieNamed(refusedLogin, "__Host-comms_session")).toBe("");
	expect(cookieNamed(refusedLogin, "__Host-chirp_oidc")).toContain("Max-Age=0");
	// The manifest describes every new route.
	const manifest = JSON.stringify(await (await fetch(`${board.url}/.well-known/agent.json`)).json());
	for (const path of [
		"/auth/oidc/client.json",
		"/_boot/auth/oidc/start",
		"/auth/oidc/callback",
		"/_boot/auth/identities",
		"/_boot/auth/identities/{id}",
	])
		expect(manifest).toContain(`"${path}"`);
}, 60_000);
