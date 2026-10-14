import { assertionHeader } from "@comms/protocol/headers";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

type App = Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) => Schema.decodeUnknownSync(schema)(value);
const OAuthError = Schema.Struct({ error: Schema.String, error_description: Schema.String });
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, scope: Schema.String });
const Posted = Schema.Struct({
	result: Schema.Struct({ structuredContent: Schema.Struct({ agent: Schema.String, instance: Schema.String }) }),
});

/** A board with the MCP package installed; `localMetadata` lets it fetch client metadata from this machine over HTTP. */
const installed = async (test: TestContext, localMetadata: boolean) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await cp(join(import.meta.dirname, "../../../examples/extensions/mcp"), join(seed, "ext/mcp"), { recursive: true });
	for (const file of (await readdir(join(seed, "ext/mcp"))).filter((name) => name.endsWith(".ts"))) {
		const path = join(seed, "ext/mcp", file);
		await writeFile(
			path,
			(await readFile(path, "utf8"))
				.replace("../../../packages/server/src/kernel/extension-api.ts", "../../kernel/extension-api.ts")
				.replace("https://your-board.example", "https://comms.test")
				.replace("const allowLocalMetadata = false;", `const allowLocalMetadata = ${localMetadata};`),
		);
	}
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	return { fixture, app, cookie };
};

type Reply =
	| { readonly status?: number; readonly headers?: Readonly<Record<string, string>>; readonly body: string }
	| "stall";
/** Serves client metadata documents from this machine and counts how often each path is fetched. */
const metadataHost = async (test: TestContext, routes: (base: string) => Readonly<Record<string, Reply>>) => {
	const hits = new Map<string, number>();
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		hits.set(path, (hits.get(path) ?? 0) + 1);
		const reply = served[path] ?? { status: 404, body: "" };
		if (reply === "stall") {
			response.writeHead(200, { "content-type": "application/json" });
			response.write("{");
			return;
		}
		response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
		response.end(reply.body);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	test.onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("metadata host has no address");
	const base = `http://127.0.0.1:${address.port}`;
	const served = routes(base);
	return { base, hits: (path: string) => hits.get(path) ?? 0 };
};
const metadataDocument = (clientId: string, fields: Readonly<Record<string, unknown>> = {}) =>
	JSON.stringify({
		client_id: clientId,
		client_name: "Metadata Client",
		redirect_uris: ["https://client.test/callback"],
		grant_types: ["authorization_code", "refresh_token"],
		token_endpoint_auth_method: "none",
		...fields,
	});

const pkce = (marker: string) => {
	const verifier = createHash("sha256").update(marker).digest("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authorizeQuery = (clientId: string, challenge: string, fields: Readonly<Record<string, string>> = {}) =>
	new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: "https://comms.test/mcp",
		scope: "read write",
		state: "state-1",
		...fields,
	});
const consent = (app: App, cookie: string, query: URLSearchParams) =>
	fetch(`${app.url}/mcp/oauth/authorize?${query}`, { headers: { cookie } });
const submit = (app: App, cookie: string, path: string, fields: Readonly<Record<string, string>>) =>
	fetch(`${app.url}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
const decide = (app: App, cookie: string, query: URLSearchParams, fields: Readonly<Record<string, string>>) =>
	submit(app, cookie, "/mcp/oauth/authorize", { ...Object.fromEntries(query), ...fields });
const token = (app: App, fields: Readonly<Record<string, string>>) =>
	fetch(`${app.url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ resource: "https://comms.test/mcp", ...fields }),
	});
const mcp = (app: App, access: string, id: number, method: string, params?: unknown) =>
	fetch(`${app.url}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${access}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-11-25",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
	});
/** The consent step's editing page: its request code, boot's approval link and the continuation token. */
const editingStep = async (response: Response) => {
	expect(response.status).toBe(200);
	const html = await response.text();
	return {
		code: /request code is <code>([0-9A-F]{6})<\/code>/.exec(html)?.[1] ?? "",
		approval: /href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "",
		consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] ?? "",
	};
};
/** The human approving read and write on boot's page, signed with the test passkey. */
const approveAtBoot = async (app: App, approveUrl: string) => {
	const id = new URL(approveUrl).pathname.split("/").at(-1) ?? "";
	const body = { decision: "approve" as const, scopes: ["read", "write"], long_lived: false };
	const decided = await fetch(`${app.url}/_boot/enroll/${id}/approve`, {
		method: "POST",
		headers: {
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: await app.assertion({ id, ...body }),
		},
		body: JSON.stringify(body),
	});
	expect(decided.status, await decided.clone().text()).toBe(200);
};
const Info = Schema.Struct({
	result: Schema.Struct({
		structuredContent: Schema.Struct({
			client_id: Schema.String,
			approved_by: Schema.String,
			posting_name: Schema.NullOr(Schema.String),
			editing: Schema.Struct({ status: Schema.String }),
		}),
	}),
});
const connectionInfo = async (app: App, access: string) =>
	decode(Info, await (await mcp(app, access, 9, "tools/call", { name: "connection_info", arguments: {} })).json())
		.result.structuredContent;
/** A refusal shown to the person at consent instead of a redirect: the client or its redirect is not trusted. */
const refused = async (response: Response) => {
	expect(response.status).toBe(400);
	return decode(OAuthError, await response.json()).error_description;
};
const callback = (response: Response) => {
	expect(response.status).toBe(302);
	return new URL(response.headers.get("location") ?? "");
};

it("resumes a metadata-document connection over https and keeps each loopback approval apart", async (test) => {
	const { fixture, app, cookie } = await installed(test, true);
	const host = await metadataHost(test, (base) => ({
		"/client.json": {
			headers: { "cache-control": "public, max-age=300" },
			body: metadataDocument(`${base}/client.json`, {
				redirect_uris: ["https://client.test/callback", "http://127.0.0.1/callback"],
			}),
		},
		"/other.json": { body: metadataDocument(`${base}/other.json`) },
	}));
	const clientId = `${host.base}/client.json`;
	expect(await (await fetch(`${app.url}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
		issuer: "https://comms.test",
		scopes_supported: ["read", "write", "offline_access"],
		token_endpoint_auth_methods_supported: ["none"],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
	});
	// A refresh token is not something the resource requires, so neither its metadata nor its challenge asks for one.
	expect(await (await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({
		scopes_supported: ["read", "write"],
	});
	expect((await mcp(app, `chirp_app_${"a".repeat(43)}`, 0, "ping")).headers.get("www-authenticate")).toContain(
		'scope="read write"',
	);
	const exchange = (
		code: string,
		verifier: string,
		redirect = "https://client.test/callback",
		presentedId = clientId,
	) =>
		token(app, {
			grant_type: "authorization_code",
			client_id: presentedId,
			redirect_uri: redirect,
			code,
			code_verifier: verifier,
		});
	const connected = async (response: Response, verifier: string, redirect?: string) => {
		const exchanged = await exchange(callback(response).searchParams.get("code") ?? "", verifier, redirect);
		expect(exchanged.status).toBe(200);
		const tokens = decode(Tokens, await exchanged.json());
		return { ...tokens, info: await connectionInfo(app, tokens.access_token) };
	};

	const first = pkce("first");
	const firstQuery = authorizeQuery(clientId, first.challenge, { scope: "read write offline_access" });
	const page = await consent(app, cookie, firstQuery);
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("Authorize Metadata Client");
	expect(html).toContain('name="agent" value="metadata-client"');
	expect(html).toContain(`published by <strong>${new URL(clientId).host}</strong>`);
	expect(html).toContain("returns to <strong>client.test</strong>.</p>");
	expect(html).toContain(`name="client_id" value="${clientId}"`);
	// Editing goes through boot's passkey approval; finishing from there is an authorization response too.
	const step = await editingStep(
		await decide(app, cookie, firstQuery, { decision: "approve", agent: "meta-bot", editing: "1" }),
	);
	await approveAtBoot(app, step.approval);
	expect(
		await (await fetch(`${app.url}/mcp/oauth/continue?consent=${step.consent}`, { headers: { cookie } })).text(),
	).toContain("Finish connecting Metadata Client");
	const finished = await submit(app, cookie, "/mcp/oauth/continue", { consent: step.consent });
	const firstCallback = callback(finished);
	expect(firstCallback.origin + firstCallback.pathname).toBe("https://client.test/callback");
	expect(firstCallback.searchParams.get("iss")).toBe("https://comms.test");
	expect(firstCallback.searchParams.get("state")).toBe("state-1");
	// Approval reused the document fetched for the consent page.
	expect(host.hits("/client.json")).toBe(1);
	// The code belongs to the URL it was approved for, not to another metadata client.
	const firstCode = firstCallback.searchParams.get("code") ?? "";
	expect(
		decode(
			OAuthError,
			await (
				await exchange(firstCode, first.verifier, "https://client.test/callback", `${host.base}/other.json`)
			).json(),
		).error,
	).toBe("invalid_grant");
	const a = await connected(finished, first.verifier);
	// offline_access was accepted and changed nothing: the grant is read and write, with a refresh token as always.
	expect(a.scope).toBe("read write");
	expect(a.refresh_token).toMatch(/^mcp_refresh_/);
	expect(a.info.editing.status).toBe("active");
	// One connection per URL and approving human, so no other human's approval can resume it.
	expect(a.info.client_id).toBe(
		`mcp_cimd_${createHash("sha256")
			.update(JSON.stringify([clientId, a.info.approved_by]))
			.digest()
			.subarray(0, 24)
			.toString("base64url")}`,
	);

	// Reconnecting over https resumes that connection: same id and name, and its grant without another passkey.
	const second = pkce("second");
	const secondQuery = authorizeQuery(clientId, second.challenge);
	expect(await (await consent(app, cookie, secondQuery)).text()).toContain('name="agent" value="meta-bot"');
	expect(host.hits("/client.json")).toBe(1);
	const b = await connected(
		await decide(app, cookie, secondQuery, { decision: "approve", agent: "meta-bot", editing: "1" }),
		second.verifier,
	);
	expect(b.info).toEqual(a.info);
	const recorded = decode(
		Schema.Array(Schema.Struct({ payload: Schema.String })),
		await fixture.sql(`SELECT payload FROM example_mcp_oauth WHERE kind='client' AND id='${a.info.client_id}'`),
	);
	expect(recorded.map((row) => decode(Schema.fromJsonString(Schema.Unknown), row.payload))).toEqual([
		{
			client_name: "Metadata Client",
			redirect_uris: ["https://client.test/callback", "http://127.0.0.1/callback"],
			client_url: clientId,
		},
	]);

	// Any program on this device can present the same URL with a loopback callback, so each such approval is a new
	// connection: it is warned about, inherits no grant, and asks boot for its own.
	const loopback = "http://127.0.0.1:53682/callback";
	const third = pkce("third");
	const thirdQuery = authorizeQuery(clientId, third.challenge, { redirect_uri: loopback });
	expect(await (await consent(app, cookie, thirdQuery)).text()).toContain(
		"returns to <strong>127.0.0.1:53682</strong>. That is a program on this device",
	);
	const own = await editingStep(
		await decide(app, cookie, thirdQuery, { decision: "approve", agent: "meta-bot", editing: "1" }),
	);
	expect(own.code).not.toBe(step.code);
	const c = await connected(
		await submit(app, cookie, "/mcp/oauth/continue", { consent: own.consent }),
		third.verifier,
		loopback,
	);
	expect(c.info.client_id).toMatch(/^mcp_cimd_[A-Za-z0-9_-]{32}$/);
	expect(c.info.client_id).not.toBe(a.info.client_id);
	expect(c.info.editing.status).toBe("pending");
	expect((await connectionInfo(app, a.access_token)).editing.status).toBe("active");
	const fourth = pkce("fourth");
	const d = await connected(
		await decide(app, cookie, authorizeQuery(clientId, fourth.challenge, { redirect_uri: loopback }), {
			decision: "approve",
			agent: "meta-bot",
		}),
		fourth.verifier,
		loopback,
	);
	expect(d.info.client_id).not.toBe(c.info.client_id);
	// A connection id is short enough for the posting instance and the longest idempotency key.
	const posted = await mcp(app, d.access_token, 1, "tools/call", {
		name: "post_message",
		arguments: { topic: "plans", body: "From a metadata client", idempotencyKey: "k".repeat(156) },
	});
	expect(decode(Posted, await posted.json()).result.structuredContent).toEqual({
		agent: "meta-bot",
		instance: `extension:mcp:${d.info.client_id}`,
	});

	// A connection id is not a client_id anyone can present.
	expect(await refused(await consent(app, cookie, authorizeQuery(a.info.client_id, second.challenge)))).toBe(
		"client_id is not registered with this board.",
	);
	const refresh = { grant_type: "refresh_token", refresh_token: c.refresh_token };
	expect((await token(app, { ...refresh, client_id: c.info.client_id })).status).toBe(400);
	expect((await token(app, { ...refresh, client_id: `${host.base}/other.json` })).status).toBe(400);
	expect((await token(app, { ...refresh, client_id: clientId })).status).toBe(200);
}, 60000);

it("refuses metadata documents that do not describe the client", async (test) => {
	const { app, cookie } = await installed(test, true);
	const host = await metadataHost(test, (base) => ({
		"/client.json": {
			body: metadataDocument(`${base}/client.json`, {
				redirect_uris: ["https://client.test/callback", "myapp://callback"],
			}),
		},
		"/mismatch.json": { body: metadataDocument(`${base}/other.json`) },
		"/unnamed.json": {
			body: JSON.stringify({ client_id: `${base}/unnamed.json`, redirect_uris: ["https://client.test/callback"] }),
		},
		"/secret.json": {
			body: metadataDocument(`${base}/secret.json`, { token_endpoint_auth_method: "client_secret_basic" }),
		},
		"/large.json": {
			body: metadataDocument(`${base}/large.json`, { client_uri: `https://client.test/${"x".repeat(6000)}` }),
		},
		"/moved.json": { status: 302, headers: { location: `${base}/client.json` }, body: "" },
		"/stall.json": "stall",
		// ChatGPT's document prefers private_key_jwt and also lists none, which it uses with a public-client server.
		"/chatgpt.json": {
			body: metadataDocument(`${base}/chatgpt.json`, {
				token_endpoint_auth_method: "private_key_jwt",
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			}),
		},
		"/no-store.json": { headers: { "cache-control": "no-store" }, body: metadataDocument(`${base}/no-store.json`) },
	}));
	const { challenge } = pkce("refusals");
	const ask = (path: string, fields: Readonly<Record<string, string>> = {}) =>
		consent(app, cookie, authorizeQuery(`${host.base}${path}`, challenge, fields));

	expect(await refused(await ask("/client.json", { redirect_uri: "https://client.test/other" }))).toBe(
		"redirect_uri is not registered for this client.",
	);
	// Listed, but not a redirect this board accepts from any client.
	expect(await refused(await ask("/client.json", { redirect_uri: "myapp://callback" }))).toBe(
		"redirect_uri is not registered for this client.",
	);
	expect(await refused(await ask("/mismatch.json"))).toBe(
		`The client metadata document at ${host.base}/mismatch.json names a different client_id.`,
	);
	// A document that failed is fetched again next time rather than cached.
	await ask("/mismatch.json");
	expect(host.hits("/mismatch.json")).toBe(2);
	expect(await refused(await ask("/unnamed.json"))).toContain(
		"is not JSON with client_id, client_name and redirect_uris",
	);
	expect(await refused(await ask("/secret.json"))).toContain("accepts only public clients");
	expect(await refused(await ask("/large.json"))).toContain("is larger than 5 KiB");
	// Redirects are never followed, so the document they point at is not fetched for them.
	expect(await refused(await ask("/moved.json"))).toContain("answered HTTP 302");
	expect(host.hits("/client.json")).toBe(1);
	const started = Date.now();
	expect(await refused(await ask("/stall.json"))).toContain("did not arrive within five seconds");
	expect(Date.now() - started).toBeLessThan(9000);

	expect((await ask("/chatgpt.json")).status).toBe(200);
	expect((await ask("/no-store.json")).status).toBe(200);
	expect((await ask("/no-store.json")).status).toBe(200);
	expect(host.hits("/no-store.json")).toBe(2);
}, 60000);

it("never fetches client metadata from private addresses on a public board", async (test) => {
	const { app, cookie } = await installed(test, false);
	const connections = { count: 0 };
	const listener = createNetServer((socket) => {
		connections.count++;
		socket.destroy();
	});
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	test.onTestFinished(() => new Promise<void>((resolve) => listener.close(() => resolve())));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("listener has no address");
	const { challenge } = pkce("private");
	for (const clientId of [
		`https://127.0.0.1:${address.port}/client.json`,
		`https://localhost:${address.port}/client.json`,
		`https://[::ffff:7f00:1]:${address.port}/client.json`,
		"https://169.254.169.254/latest/client.json",
	])
		expect(await refused(await consent(app, cookie, authorizeQuery(clientId, challenge))), clientId).toBe(
			`The client metadata document at ${clientId} is not on a public address.`,
		);
	// Plain HTTP is not a metadata URL here, so it is just an unknown client_id.
	expect(
		await refused(
			await consent(app, cookie, authorizeQuery(`http://127.0.0.1:${address.port}/client.json`, challenge)),
		),
	).toBe("client_id is not registered with this board.");
	expect(connections.count).toBe(0);
}, 30000);

it("names the issuer in every authorization response and keeps registered clients working", async (test) => {
	const { app, cookie } = await installed(test, false);
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Registered client",
			redirect_uris: ["https://client.test/callback", "http://127.0.0.1/callback", "http://localhost/callback"],
		}),
	});
	expect(registration.status).toBe(201);
	const clientId = decode(Schema.Struct({ client_id: Schema.String }), await registration.json()).client_id;
	expect(clientId).toMatch(/^mcp_client_[A-Za-z0-9_-]{32}$/);
	const { verifier, challenge } = pkce("registered");
	const query = authorizeQuery(clientId, challenge);

	const denied = callback(await decide(app, cookie, query, { decision: "deny" }));
	expect(Object.fromEntries(denied.searchParams)).toEqual({
		error: "access_denied",
		state: "state-1",
		iss: "https://comms.test",
	});
	// An empty state is returned exactly as sent.
	const blank = callback(
		await decide(app, cookie, authorizeQuery(clientId, challenge, { state: "" }), { decision: "deny" }),
	);
	expect(blank.searchParams.get("state")).toBe("");
	const page = await (await consent(app, cookie, query)).text();
	expect(page).toContain("returns to <strong>client.test</strong>.</p>");
	expect(page).not.toContain("published by");
	const approved = callback(await decide(app, cookie, query, { decision: "approve", agent: "registered-bot" }));
	expect(approved.searchParams.get("iss")).toBe("https://comms.test");
	const exchanged = await token(app, {
		grant_type: "authorization_code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code: approved.searchParams.get("code") ?? "",
		code_verifier: verifier,
	});
	expect(exchanged.status).toBe(200);
	expect((await mcp(app, decode(Tokens, await exchanged.json()).access_token, 1, "ping")).status).toBe(200);

	// A loopback redirect may name whatever port the native client opened; the rest must still match.
	for (const redirect of ["http://127.0.0.1:53682/callback", "http://localhost:4100/callback"]) {
		const loopback = await consent(app, cookie, authorizeQuery(clientId, challenge, { redirect_uri: redirect }));
		expect(loopback.status, redirect).toBe(200);
		expect(await loopback.text()).toContain(
			`returns to <strong>${new URL(redirect).host}</strong>. That is a program on this device`,
		);
	}
	expect(
		await refused(
			await consent(app, cookie, authorizeQuery(clientId, challenge, { redirect_uri: "http://127.0.0.1:53682/other" })),
		),
	).toBe("redirect_uri is not registered for this client.");
	expect(
		await refused(
			await consent(
				app,
				cookie,
				authorizeQuery(clientId, challenge, { redirect_uri: "https://client.test:8443/callback" }),
			),
		),
	).toBe("redirect_uri is not registered for this client.");
}, 40000);
