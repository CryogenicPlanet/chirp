import { assertionHeader, grantExtensionHeader, grantHeader } from "@comms/protocol/headers";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { approvalReturn } from "../src/enrollment-page.ts";
import { authenticator } from "./fixtures/authenticator.ts";

const ceremony = Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) });
const Channel = Schema.Struct({ secret: Schema.String, url: Schema.String });
const Created = Schema.Struct({
	id: Schema.String,
	approve_url: Schema.String,
	user_code: Schema.String,
	expires_at: Schema.Int,
});
const Approved = Schema.Struct({
	status: Schema.Literal("approved"),
	family: Schema.String,
	agent: Schema.String,
	label: Schema.String,
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
});
const Echo = Schema.Struct({
	method: Schema.String,
	body: Schema.String,
	agent: Schema.NullOr(Schema.String),
	instance: Schema.NullOr(Schema.String),
	scopes: Schema.NullOr(Schema.String),
	kind: Schema.NullOr(Schema.String),
	authorization: Schema.NullOr(Schema.String),
	cookie: Schema.NullOr(Schema.String),
	assertion: Schema.NullOr(Schema.String),
});
const errorCode = async (response: Response) =>
	Schema.decodeUnknownSync(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }))(await response.json())
		.error.code;

/** One boot over the fixture child, reusable across a restart of the same data directory. */
async function board(test: TestContext, root: string) {
	const seed = join(root, "seed");
	await mkdir(seed, { recursive: true });
	await copyFile(join(import.meta.dirname, "fixtures/child.ts"), join(seed, "fixture.ts"));
	await writeFile(join(seed, "child.ts"), `import { serve } from "./fixture.ts"; serve("controlled-stream");`);
	const handle = spawn("bun", [join(import.meta.dirname, "fixtures/launcher.ts")], {
		env: { ...process.env, ENTRY: join(seed, "child.ts"), DATA_DIR: join(root, "data") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-32768);
	};
	handle.stdout.on("data", capture);
	handle.stderr.on("data", capture);
	const stop = async () => {
		if (handle.exitCode !== null || handle.signalCode !== null) return;
		const exited = once(handle, "exit");
		handle.kill("SIGTERM");
		await Promise.race([exited, delay(4000)]);
		if (handle.exitCode === null && handle.signalCode === null) handle.kill("SIGKILL");
		await exited;
	};
	test.onTestFinished(stop);
	let url = "";
	await expect
		.poll(() => (url = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? ""), { timeout: 10000 })
		.not.toBe("");
	await expect.poll(async () => (await fetch(`${url}/_boot/auth/state`)).status, { timeout: 10000 }).toBe(200);
	return { url, stop, output: () => output };
}

async function launch(test: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "comms-grant-http-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const device = authenticator();
	let counter = 0;
	let app = await board(test, root);
	const post = (path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
		fetch(`${app.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://comms.test", ...headers },
			body: JSON.stringify(body),
		});
	const login = async () => {
		const options = Schema.decodeUnknownSync(ceremony)(await (await post("/_boot/auth/login/options", {})).json());
		const response = await post("/_boot/auth/login/verify", {
			id: options.id,
			response: device.assertion(options.options.challenge, ++counter),
		});
		const cookie = response.headers.get("set-cookie")?.split(";")[0];
		if (!cookie) throw new Error("Missing session cookie");
		return cookie;
	};
	await expect.poll(() => /\/setup is open, code ([A-F0-9]+)/.exec(app.output())?.[1]).toBeTruthy();
	const setup = Schema.decodeUnknownSync(ceremony)(
		await (
			await post("/_boot/auth/setup/options", { code: /\/setup is open, code ([A-F0-9]+)/.exec(app.output())?.[1] })
		).json(),
	);
	expect(
		(await post("/_boot/auth/setup/verify", { id: setup.id, response: device.registration(setup.options.challenge) }))
			.status,
	).toBe(200);
	let cookie = await login();
	const live = async () =>
		expect
			.poll(
				async () => {
					const status = await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json();
					return Schema.decodeUnknownSync(Schema.Struct({ child: Schema.Struct({ state: Schema.String }) }))(status)
						.child.state;
				},
				{ timeout: 15000 },
			)
			.toBe("live");
	await live();
	const channel = async () =>
		Schema.decodeUnknownSync(Channel)(
			await (await fetch(`${app.url}/fixture-channel`, { headers: { cookie } })).json(),
		);
	const signed = async (action: string, params: unknown, session?: string) => {
		const started = Schema.decodeUnknownSync(ceremony)(
			await (await post("/_boot/auth/challenge", { action, params }, session ? { cookie: session } : {})).json(),
		);
		return Buffer.from(
			JSON.stringify({ id: started.id, response: device.assertion(started.options.challenge, ++counter) }),
		).toString("base64url");
	};
	const approve = async (id: string, scopes: readonly string[], body: readonly string[] = scopes) =>
		post(
			`/_boot/enroll/${id}/approve`,
			{ decision: "approve", scopes: body, long_lived: false },
			{ [assertionHeader]: await signed("enrollment.decide", { id, decision: "approve", scopes, long_lived: false }) },
		);
	/** As the live app: the secret proves the channel; the grant names the family boot holds. */
	const asApp = (secret: string) => ({
		call: (path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
			fetch(`${app.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-boot-secret": secret, ...headers },
				body: JSON.stringify(body),
			}),
		grant: (
			family: string,
			path: string,
			init: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> } = {},
		) =>
			fetch(`${app.url}${path}`, {
				method: init.method ?? "GET",
				headers: {
					"x-boot-secret": secret,
					[grantHeader]: family,
					[grantExtensionHeader]: "mcp",
					...(init.body === undefined ? {} : { "content-type": "application/json" }),
					...init.headers,
				},
				...(init.body === undefined ? {} : { body: init.body }),
			}),
	});
	const grant = async (secret: string, scopes: readonly string[] = ["read", "write", "fs"]) => {
		const app = asApp(secret);
		const created = Schema.decodeUnknownSync(Created)(
			await (await app.call("/_boot/grants", { extension: "mcp", agent: "dot", label: "chatgpt", scopes })).json(),
		);
		expect((await approve(created.id, scopes)).status).toBe(200);
		return Schema.decodeUnknownSync(Approved)(
			await (await app.call(`/_boot/grants/${created.id}`, { extension: "mcp" })).json(),
		);
	};
	return {
		root,
		get url() {
			return app.url;
		},
		get cookie() {
			return cookie;
		},
		post,
		live,
		channel,
		signed,
		approve,
		asApp,
		grant,
		restart: async () => {
			await app.stop();
			app = await board(test, root);
			cookie = await login();
			await live();
		},
	};
}

it("creates, approves and collects a held grant, then forwards it as the approved agent", async (test) => {
	const app = await launch(test);
	const { secret } = await app.channel();
	const internal = app.asApp(secret);
	const request = { extension: "mcp", agent: "dot", label: "chatgpt", scopes: ["read", "write", "fs"] };
	// The private channel refuses callers without the live secret or with any other credential.
	for (const headers of [
		{ "x-boot-secret": "0".repeat(64) },
		{ authorization: `Bearer ${"a".repeat(43)}` },
		{ cookie: app.cookie },
		{ "x-forwarded-for": "10.0.0.1" },
	]) {
		const refused = await internal.call("/_boot/grants", request, headers);
		expect(refused.status).toBe(403);
		expect(await errorCode(refused)).toBe("grant_forbidden");
	}
	expect((await app.post("/_boot/grants", request, { cookie: app.cookie })).status).toBe(403);
	expect(await errorCode(await internal.call("/_boot/grants", { ...request, agent: "rahul" }))).toBe("invalid_request");
	const created = Schema.decodeUnknownSync(Created)(await (await internal.call("/_boot/grants", request)).json());
	expect(created.approve_url).toBe(`https://comms.test/approve/${created.id}`);
	expect(await (await internal.call(`/_boot/grants/${created.id}`, { extension: "mcp" })).json()).toEqual({
		status: "pending",
		expires_at: created.expires_at,
	});
	expect((await internal.call(`/_boot/grants/${created.id}`, { extension: "other" })).status).toBe(404);

	// The approval page describes the request only from boot's row, with fs unticked and no device code.
	const page = await (await fetch(`${app.url}/approve/${created.id}`)).text();
	expect(page).toContain(
		"Extension <strong>mcp</strong> asks to act as agent <strong>dot</strong> (chatgpt). Boot keeps this access; it is never sent to the extension.",
	);
	expect(page).toContain('<input id="fs" type="checkbox">');
	expect(page).toContain('<input id="write" type="checkbox" checked>');
	expect(page).toContain("Access lasts 90 days");
	expect(page).not.toContain("Long-lived");
	// The requester's code ties this link to the connection that asked for it.
	expect(created.user_code).toMatch(/^[A-F0-9]{6}$/);
	expect(page).toContain(`<code>${created.user_code}</code>`);
	expect(page).toContain("Anything the board's app runs can use this access");
	expect(page).toContain(
		"With fs, anything running in the app, including code another fs agent installs, can act as dot",
	);
	expect(page).not.toContain("data-return");
	const returned = await (
		await fetch(`${app.url}/approve/${created.id}?return=${encodeURIComponent("/mcp/oauth/authorize?state=a&b=<x>")}`)
	).text();
	expect(returned).toContain('data-return="/mcp/oauth/authorize?state=a&amp;b=%3Cx%3E"');
	for (const target of [
		"https://evil.test/x",
		"//evil.test/x",
		"/\\evil.test",
		"/a\r\nb",
		"javascript:alert(1)",
		"/x\t/y",
	]) {
		const refused = await (await fetch(`${app.url}/approve/${created.id}?return=${encodeURIComponent(target)}`)).text();
		expect(refused).not.toContain("data-return");
	}

	// A proof binds the exact decision; the body cannot widen it.
	const mismatched = await app.approve(created.id, ["read", "write"], ["read", "write", "fs"]);
	expect(mismatched.status).toBe(401);
	expect(await errorCode(mismatched)).toBe("challenge_invalid");
	expect((await app.approve(created.id, ["read", "write", "fs"])).status).toBe(200);
	const collected = await (await internal.call(`/_boot/grants/${created.id}`, { extension: "mcp" })).json();
	const approved = Schema.decodeUnknownSync(Approved)(collected);
	expect(Object.keys(collected).sort()).toEqual(["agent", "expires_at", "family", "label", "scopes", "status"]);
	expect(approved).toMatchObject({ agent: "dot", label: "chatgpt", scopes: ["read", "write", "fs"] });

	// Forwarded as the agent: instance is the family, and no credential crosses to the app.
	const echoed = Schema.decodeUnknownSync(Echo)(
		await (await internal.grant(approved.family, "/echo", { method: "POST", body: '{"hello":1}' })).json(),
	);
	expect(echoed).toMatchObject({
		method: "POST",
		body: '{"hello":1}',
		agent: "dot",
		instance: approved.family,
		scopes: "read,write,fs",
		kind: "agent",
		authorization: null,
		cookie: null,
		assertion: null,
	});
	const events = Schema.decodeUnknownSync(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({ type: Schema.String, actor: Schema.String, instance: Schema.NullOr(Schema.String) }),
			),
		}),
	)(await (await fetch(`${app.url}/_boot/events?limit=200`, { headers: { cookie: app.cookie } })).json());
	expect(
		events.items.some(
			(event) => event.type === "http.request" && event.actor === "dot" && event.instance === approved.family,
		),
	).toBe(true);

	// The gate refuses before any credential path: no secret, a wrong one, a foreign host, proxies, extra credentials.
	const family = approved.family;
	const refusals: Array<Promise<Response>> = [
		fetch(`${app.url}/echo`, { headers: { [grantHeader]: family, [grantExtensionHeader]: "mcp" } }),
		internal.grant(family, "/echo", { headers: { "x-boot-secret": "0".repeat(64) } }),
		internal.grant(family, "/echo", { headers: { "x-forwarded-for": "10.0.0.1" } }),
		internal.grant(family, "/echo", { headers: { forwarded: "for=10.0.0.1" } }),
		internal.grant(family, "/echo", { headers: { authorization: `Bearer ${"a".repeat(43)}` } }),
		internal.grant(family, "/echo", { headers: { authorization: `Bearer chirp_app_${"a".repeat(43)}` } }),
		internal.grant(family, "/echo", { headers: { cookie: app.cookie } }),
		internal.grant(family, "/echo", { headers: { [assertionHeader]: "proof" } }),
	];
	for (const response of await Promise.all(refusals)) {
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("grant_forbidden");
	}
	const wrongHost = await new Promise<number>((resolve, reject) => {
		const outgoing = httpRequest(`${app.url}/echo`, {
			headers: { host: "comms.test", "x-boot-secret": secret, [grantHeader]: family, [grantExtensionHeader]: "mcp" },
		});
		outgoing.on("response", (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
	expect(wrongHost).toBe(403);
	expect(await errorCode(await internal.grant(family, "/echo", { headers: { [grantExtensionHeader]: "other" } }))).toBe(
		"grant_invalid",
	);
	// Authentication, tokens, approval, reset, revert, restore, backup and boot internals stay out of reach.
	for (const [method, path] of [
		["POST", "/api/revert"],
		["POST", "/api/reset"],
		["POST", "/_boot/reset"],
		["POST", "/_boot/db/backup"],
		["POST", "/_boot/db/restore"],
		["GET", "/_boot/db/backups"],
		["POST", "/_boot/restart"],
		["POST", "/auth/enroll"],
		["POST", "/_boot/enroll"],
		["POST", "/_boot/refresh"],
		["POST", "/auth/refresh"],
		["GET", "/_boot/tokens"],
		["POST", "/api/tokens"],
		["POST", `/_boot/tokens/${family}/revoke`],
		["GET", "/_boot/auth/passkeys"],
		["POST", "/_boot/auth/challenge"],
		["POST", "/_boot/grants"],
		["GET", "/_boot/events"],
		["GET", "/_boot/settings"],
		["GET", `/approve/${created.id}`],
		["GET", "/setup"],
		["PUT", "/api/fs/app/x.ts?baseVersion=null"],
		["PUT", "/api/fs/app/x.ts?baseVersion=null&reload=1"],
		["PUT", "/api/fs/%61pp/x.ts?baseVersion=null"],
		["DELETE", "/api/fs/app/x.ts?baseVersion=null"],
		["DELETE", "/api/lock?break=1"],
	] as const) {
		const response = await internal.grant(family, path, {
			method,
			...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
		});
		expect([path, response.status]).toEqual([path, 403]);
		expect(await errorCode(response)).toBe("grant_forbidden");
	}
	expect((await internal.grant(family, "/_kernel/control")).status).toBe(403);
	// Grants may still read boot diagnostics with fs scope and hold the edit lock.
	expect((await internal.grant(family, "/_boot/status")).status).toBe(200);
	const locked = await internal.grant(family, "/api/lock", { method: "POST", body: "{}" });
	expect(locked.status).toBe(200);
	expect(await locked.json()).toMatchObject({ lock: { holder_family: family, agent: "dot" } });
	expect(
		(await internal.grant(family, "/api/fs/app/x.ts?baseVersion=null&reload=0", { method: "PUT", body: "x" })).status,
	).toBe(200);

	// The account listing names the extension holding this family.
	const families = Schema.decodeUnknownSync(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ family: Schema.String, held_by: Schema.NullOr(Schema.String) })),
		}),
	)(await (await fetch(`${app.url}/_boot/tokens`, { headers: { cookie: app.cookie } })).json());
	expect(families.items.find((item) => item.family === family)?.held_by).toBe("mcp");

	// Revocation ends an open stream at its next chunk, refuses the next request and releases the lock.
	const stream = await internal.grant(family, "/stream");
	expect(stream.status).toBe(200);
	const reader = stream.body?.getReader();
	if (!reader) throw new Error("Missing stream");
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
	const revoked = await app.post(
		`/_boot/tokens/${family}/revoke`,
		{},
		{ cookie: app.cookie, [assertionHeader]: await app.signed("token.revoke", { family }, app.cookie) },
	);
	expect(revoked.status).toBe(200);
	expect((await app.post("/release-stream", {}, { cookie: app.cookie })).status).toBe(204);
	const rest = await reader.read();
	expect(rest.done ? "" : new TextDecoder().decode(rest.value)).not.toContain("second");
	const after = await internal.grant(family, "/echo");
	expect(after.status).toBe(401);
	expect(await errorCode(after)).toBe("grant_invalid");
	expect(await (await fetch(`${app.url}/api/lock`, { headers: { cookie: app.cookie } })).json()).toEqual({
		lock: null,
	});
	expect(await (await internal.call(`/_boot/grants/${created.id}`, { extension: "mcp" })).json()).toEqual({
		status: "revoked",
		family,
	});
}, 60000);

it("refuses read-only grants on fs routes and keeps grants across restarts but not attempt secrets", async (test) => {
	const app = await launch(test);
	const first = await app.channel();
	const reader = await app.grant(first.secret, ["read"]);
	const writer = await app.grant(first.secret, ["read", "write", "fs"]);
	const internal = app.asApp(first.secret);
	for (const [method, path] of [
		["POST", "/api/lock"],
		["PUT", "/api/fs/pages/notes.md?baseVersion=null"],
		["GET", "/_boot/status"],
	] as const) {
		const response = await internal.grant(reader.family, path, { method, ...(method === "GET" ? {} : { body: "{}" }) });
		expect([path, response.status]).toEqual([path, 403]);
		expect(await errorCode(response)).toBe("scope_required");
	}
	expect((await internal.grant(reader.family, "/echo")).status).toBe(200);

	// A child replaced after a crash gets a new secret; the old one is refused at once.
	expect((await fetch(`${app.url}/crash`, { headers: { cookie: app.cookie } })).status).toBe(200);
	await expect
		.poll(async () => (await app.channel().catch(() => first)).secret, { timeout: 15000 })
		.not.toBe(first.secret);
	await app.live();
	const second = await app.channel();
	expect(await errorCode(await internal.grant(writer.family, "/echo"))).toBe("grant_forbidden");
	expect((await app.asApp(second.secret).grant(writer.family, "/echo")).status).toBe(200);

	// A boot restart keeps grants in boot's store; secrets live only in its memory.
	await app.restart();
	const third = await app.channel();
	expect(third.secret).not.toBe(second.secret);
	for (const old of [first.secret, second.secret])
		expect(await errorCode(await app.asApp(old).grant(writer.family, "/echo"))).toBe("grant_forbidden");
	const echoed = Schema.decodeUnknownSync(Echo)(
		await (await app.asApp(third.secret).grant(writer.family, "/echo")).json(),
	);
	expect(echoed).toMatchObject({ agent: "dot", instance: writer.family, scopes: "read,write,fs" });
}, 90000);

it("sends a human back only to a same-origin path", () => {
	const origin = "https://comms.test";
	expect(approvalReturn("/mcp/oauth/authorize?x=1#y", origin)).toBe("/mcp/oauth/authorize?x=1#y");
	expect(approvalReturn("/", origin)).toBe("/");
	for (const value of [
		null,
		"",
		"mcp",
		"https://evil.test/",
		"//evil.test",
		"/\\evil.test",
		"\\/evil.test",
		"/a\r\nb",
		"/\t/evil.test",
		"/\u0000",
		"javascript:alert(1)",
		`/${"a".repeat(1024)}`,
		// Dot segments collapse to a protocol-relative path only after parsing.
		"/.//evil.test",
		"/%2e//evil.test",
		"/a/..//evil.test",
	])
		expect(approvalReturn(value, origin)).toBeNull();
});
