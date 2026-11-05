import { assertionHeader } from "@comms/protocol/headers";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { suggestedAgent } from "../../../src/ext/mcp/oauth.ts";
import { conversation } from "../../fixtures/conversation.ts";

type App = Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) => Schema.decodeUnknownSync(schema)(value);
const OAuthError = Schema.Struct({ error: Schema.String, error_description: Schema.String });
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String, scope: Schema.String });
const Posted = Schema.Struct({
	result: Schema.Struct({ structuredContent: Schema.Struct({ agent: Schema.String, instance: Schema.String }) }),
});

/** A fresh board serving MCP; `localMetadata` lets it fetch client metadata from this machine over HTTP. */
const installed = async (test: TestContext, localMetadata: boolean) => {
	const fixture = await conversation(test);
	const shipped = join(import.meta.dirname, "../../../src");
	const seed = join(fixture.root, "seed");
	if (localMetadata) {
		await cp(shipped, seed, { recursive: true });
		const path = join(seed, "ext/mcp/oauth.ts");
		const source = await readFile(path, "utf8");
		if (!source.includes("const allowLocalMetadata = false;"))
			throw new Error("oauth.ts no longer has allowLocalMetadata");
		await writeFile(path, source.replace("const allowLocalMetadata = false;", "const allowLocalMetadata = true;"));
	}
	const app = await fixture.launch(join(localMetadata ? seed : shipped, "server.ts"));
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
/** Consent with editing goes straight to boot's approval page, whose return link carries the continuation token. */
const editingStep = (response: Response) => {
	expect(response.status).toBe(303);
	const approval = new URL(response.headers.get("location") ?? "");
	expect(approval.origin + approval.pathname).toMatch(/^https:\/\/comms\.test\/approve\/e_[A-Za-z0-9_-]{43}$/);
	const back = approval.searchParams.get("return") ?? "";
	expect(back).toMatch(/^\/mcp\/oauth\/continue\?consent=mcp_consent_[A-Za-z0-9_-]{43}$/);
	return { approval: approval.href, consent: new URL(back, approval).searchParams.get("consent") ?? "" };
};
/** The detail line of a page refusing the person, unescaped. */
const detail = (html: string) =>
	(/<p class="detail">([^<]*)<\/p>/.exec(html)?.[1] ?? "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
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
		structuredContent: Schema.Struct({ client_id: Schema.String, editing: Schema.Struct({ status: Schema.String }) }),
	}),
});
const connectionInfo = async (app: App, access: string) =>
	decode(Info, await (await mcp(app, access, 9, "tools/call", { name: "connection_info", arguments: {} })).json())
		.result.structuredContent;
/** A refusal shown to the person at consent instead of a redirect: the client or its redirect is not trusted. */
const refused = async (response: Response) => {
	expect(response.status).toBe(400);
	expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	return detail(await response.text());
};
const callback = (response: Response) => {
	expect(response.status).toBe(302);
	return new URL(response.headers.get("location") ?? "");
};

it("connects each approval of a metadata-document client as its own connection", async (test) => {
	const { fixture, app, cookie } = await installed(test, true);
	const host = await metadataHost(test, (base) => ({
		"/client.json": {
			headers: { "cache-control": "public, max-age=300" },
			body: metadataDocument(`${base}/client.json`),
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

	const first = pkce("first");
	const firstQuery = authorizeQuery(clientId, first.challenge, { scope: "read write offline_access" });
	const page = await consent(app, cookie, firstQuery);
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(html).toContain("<h1>Connect Metadata Client to chirp</h1>");
	expect(html).toContain("Posts as <strong>metadata-client</strong>");
	expect(html).toContain('name="agent" value="metadata-client"');
	// The document is published somewhere other than where the browser returns, so consent names both.
	expect(html).toContain(`Its details are published by <strong>${new URL(clientId).host}</strong>.`);
	expect(html).toContain("You'll go back to <strong>client.test</strong>.");
	expect(html).toContain(`name="client_id" value="${clientId}"`);
	// Editing goes through boot's passkey approval; finishing from there is an authorization response too.
	const step = editingStep(
		await decide(app, cookie, firstQuery, { decision: "approve", agent: "meta-bot", editing: "1" }),
	);
	await approveAtBoot(app, step.approval);
	expect(
		await (await fetch(`${app.url}/mcp/oauth/continue?consent=${step.consent}`, { headers: { cookie } })).text(),
	).toContain("<h1>Finish connecting Metadata Client</h1>");
	const firstCallback = callback(await submit(app, cookie, "/mcp/oauth/continue", { consent: step.consent }));
	expect(firstCallback.origin + firstCallback.pathname).toBe("https://client.test/callback");
	expect(firstCallback.searchParams.get("iss")).toBe("https://comms.test");
	expect(firstCallback.searchParams.get("state")).toBe("state-1");
	// Approval reused the document fetched for the consent page.
	expect(host.hits("/client.json")).toBe(1);
	const exchange = (code: string, verifier: string, presentedId = clientId) =>
		token(app, {
			grant_type: "authorization_code",
			client_id: presentedId,
			redirect_uri: "https://client.test/callback",
			code,
			code_verifier: verifier,
		});
	const firstCode = firstCallback.searchParams.get("code") ?? "";
	// The code belongs to the URL it was approved for, not to another metadata client.
	expect(
		decode(OAuthError, await (await exchange(firstCode, first.verifier, `${host.base}/other.json`)).json()).error,
	).toBe("invalid_grant");
	const exchanged = await exchange(firstCode, first.verifier);
	expect(exchanged.status).toBe(200);
	const firstTokens = decode(Tokens, await exchanged.json());
	// offline_access was accepted and changed nothing: the grant is read and write, with a refresh token as always.
	expect(firstTokens.scope).toBe("read write");
	expect(firstTokens.refresh_token).toMatch(/^mcp_refresh_/);
	expect((await connectionInfo(app, firstTokens.access_token)).editing.status).toBe("active");

	// A second https approval for the same URL and human, started by another PKCE initiator (another install, another
	// account of the same client, or a phished Authorize click), is a new connection: it keeps the posting name, found
	// by URL, but not the approved grant, so editing asks boot again while the first connection keeps its own.
	const second = pkce("second");
	const secondQuery = authorizeQuery(clientId, second.challenge);
	expect(await (await consent(app, cookie, secondQuery)).text()).toContain('name="agent" value="meta-bot"');
	expect(host.hits("/client.json")).toBe(1);
	const again = editingStep(
		await decide(app, cookie, secondQuery, { decision: "approve", agent: "meta-bot", editing: "1" }),
	);
	expect(new URL(again.approval).pathname).not.toBe(new URL(step.approval).pathname);
	const secondCallback = callback(await submit(app, cookie, "/mcp/oauth/continue", { consent: again.consent }));
	const secondTokens = decode(
		Tokens,
		await (await exchange(secondCallback.searchParams.get("code") ?? "", second.verifier)).json(),
	);
	const firstInfo = await connectionInfo(app, firstTokens.access_token);
	const secondInfo = await connectionInfo(app, secondTokens.access_token);
	expect(secondInfo.editing.status).toBe("pending");
	expect(firstInfo.editing.status).toBe("active");
	for (const info of [firstInfo, secondInfo]) expect(info.client_id).toMatch(/^mcp_cimd_[A-Za-z0-9_-]{32}$/);
	expect(secondInfo.client_id).not.toBe(firstInfo.client_id);
	// The longest idempotency key fits the board's 200-character limit with the connection id and client label.
	const posted = await mcp(app, secondTokens.access_token, 1, "tools/call", {
		name: "post_message",
		arguments: { topic: "plans", body: "From a metadata client", idempotencyKey: "k".repeat(156) },
	});
	expect(decode(Posted, await posted.json()).result.structuredContent).toEqual({
		agent: "meta-bot",
		instance: `extension:mcp:${secondInfo.client_id}`,
	});
	// The client is recorded under each connection, so editing labels and the continue page can name it.
	const recorded = decode(
		Schema.Array(Schema.Struct({ payload: Schema.String })),
		await fixture.sql(`SELECT payload FROM example_mcp_oauth WHERE kind='client' AND id='${secondInfo.client_id}'`),
	);
	expect(recorded.map((row) => decode(Schema.fromJsonString(Schema.Unknown), row.payload))).toEqual([
		{ client_name: "Metadata Client", redirect_uris: ["https://client.test/callback"], client_url: clientId },
	]);

	// A connection id is not a client_id anyone can present.
	expect(await refused(await consent(app, cookie, authorizeQuery(secondInfo.client_id, second.challenge)))).toBe(
		"client_id is not registered with this board.",
	);
	const refresh = { grant_type: "refresh_token", refresh_token: secondTokens.refresh_token };
	expect((await token(app, { ...refresh, client_id: secondInfo.client_id })).status).toBe(400);
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
		// undefined drops the key. An omitted method defaults to client_secret_basic (RFC 7591) unless none is listed.
		"/default-secret.json": {
			body: metadataDocument(`${base}/default-secret.json`, { token_endpoint_auth_method: undefined }),
		},
		"/secret-methods.json": {
			body: metadataDocument(`${base}/secret-methods.json`, {
				token_endpoint_auth_method: undefined,
				token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt"],
			}),
		},
		"/public-methods.json": {
			body: metadataDocument(`${base}/public-methods.json`, {
				token_endpoint_auth_method: undefined,
				token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
			}),
		},
		"/large.json": {
			body: metadataDocument(`${base}/large.json`, { client_uri: `https://client.test/${"x".repeat(6000)}` }),
		},
		"/moved.json": { status: 302, headers: { location: `${base}/client.json` }, body: "" },
		// The URL parser keeps ; and ' in a host, and consent writes the callback's origin into its CSP.
		"/hostile-host.json": {
			body: metadataDocument(`${base}/hostile-host.json`, {
				redirect_uris: ["https://client.test;script-src*/callback", "https://client'test/callback"],
			}),
		},
		"/stall.json": "stall",
		// ChatGPT's document prefers private_key_jwt and also lists none, which it uses with a public-client server.
		"/chatgpt.json": {
			body: metadataDocument(`${base}/chatgpt.json`, {
				token_endpoint_auth_method: "private_key_jwt",
				token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
			}),
		},
		"/no-store.json": { headers: { "cache-control": "no-store" }, body: metadataDocument(`${base}/no-store.json`) },
		"/private.json": {
			headers: { "cache-control": "private, max-age=3600" },
			body: metadataDocument(`${base}/private.json`),
		},
		"/shared-zero.json": {
			headers: { "cache-control": "public, max-age=3600, s-maxage=0" },
			body: metadataDocument(`${base}/shared-zero.json`),
		},
		"/shared-age.json": {
			headers: { "cache-control": "public, max-age=0, s-maxage=60" },
			body: metadataDocument(`${base}/shared-age.json`),
		},
		"/aged.json": {
			headers: { "cache-control": "public, s-maxage=60", age: "50" },
			body: metadataDocument(`${base}/aged.json`),
		},
		"/aged-brief.json": {
			headers: { "cache-control": "public, s-maxage=3", age: "1" },
			body: metadataDocument(`${base}/aged-brief.json`),
		},
		"/aged-out.json": {
			headers: { "cache-control": "public, s-maxage=60", age: "60" },
			body: metadataDocument(`${base}/aged-out.json`),
		},
		"/expires-stale.json": {
			headers: { expires: "Wed, 21 Oct 2015 07:28:00 GMT", date: "Wed, 21 Oct 2015 07:28:01 GMT" },
			body: metadataDocument(`${base}/expires-stale.json`),
		},
		"/expires-fresh.json": {
			headers: {
				expires: new Date(Date.now() + 60_000).toUTCString(),
				date: new Date().toUTCString(),
			},
			body: metadataDocument(`${base}/expires-fresh.json`),
		},
		"/expires-zero.json": {
			headers: { expires: "0" },
			body: metadataDocument(`${base}/expires-zero.json`),
		},
		"/apparent-age.json": {
			headers: {
				"cache-control": "public, s-maxage=60",
				date: new Date(Date.now() - 60_000).toUTCString(),
			},
			body: metadataDocument(`${base}/apparent-age.json`),
		},
		"/vary-star.json": {
			headers: { vary: "*", "cache-control": "public, max-age=3600" },
			body: metadataDocument(`${base}/vary-star.json`),
		},
		"/quoted-zero.json": {
			headers: { "cache-control": 'public, s-maxage="0"' },
			body: metadataDocument(`${base}/quoted-zero.json`),
		},
		"/quoted-age.json": {
			headers: { "cache-control": 'public, max-age="0", s-maxage="60"' },
			body: metadataDocument(`${base}/quoted-age.json`),
		},
		"/heuristic-age.json": {
			headers: { age: "600" },
			body: metadataDocument(`${base}/heuristic-age.json`),
		},
		"/duplicate-age.json": {
			headers: { "cache-control": "public, max-age=3600, max-age=0" },
			body: metadataDocument(`${base}/duplicate-age.json`),
		},
		"/bogus-s-maxage.json": {
			headers: { "cache-control": "public, s-maxage=bogus, max-age=3600" },
			body: metadataDocument(`${base}/bogus-s-maxage.json`),
		},
		"/negative-max-age.json": {
			headers: { "cache-control": "public, max-age=-1" },
			body: metadataDocument(`${base}/negative-max-age.json`),
		},
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
	expect(await refused(await ask("/default-secret.json"))).toContain("accepts only public clients");
	expect(await refused(await ask("/secret-methods.json"))).toContain("accepts only public clients");
	expect(await refused(await ask("/large.json"))).toContain("is larger than 5 KiB");
	expect(
		await refused(await ask("/hostile-host.json", { redirect_uri: "https://client.test;script-src*/callback" })),
	).toContain("lists no HTTPS or loopback redirect URI");
	// Redirects are never followed, so the document they point at is not fetched for them.
	expect(await refused(await ask("/moved.json"))).toContain("answered HTTP 302");
	expect(host.hits("/client.json")).toBe(1);
	const started = Date.now();
	expect(await refused(await ask("/stall.json"))).toContain("did not arrive within five seconds");
	expect(Date.now() - started).toBeLessThan(9000);

	expect((await ask("/chatgpt.json")).status).toBe(200);
	expect((await ask("/public-methods.json")).status).toBe(200);
	expect((await ask("/no-store.json")).status).toBe(200);
	expect((await ask("/no-store.json")).status).toBe(200);
	expect(host.hits("/no-store.json")).toBe(2);
	// private forbids a shared cache from storing the document, even when max-age is set (RFC 9111).
	expect((await ask("/private.json")).status).toBe(200);
	expect((await ask("/private.json")).status).toBe(200);
	expect(host.hits("/private.json")).toBe(2);
	// s-maxage overrides max-age for this shared cache. Zero is not stored; a positive s-maxage is.
	expect((await ask("/shared-zero.json")).status).toBe(200);
	expect((await ask("/shared-zero.json")).status).toBe(200);
	expect(host.hits("/shared-zero.json")).toBe(2);
	expect((await ask("/shared-age.json")).status).toBe(200);
	expect((await ask("/shared-age.json")).status).toBe(200);
	expect(host.hits("/shared-age.json")).toBe(1);
	// Age reduces remaining freshness (RFC 9111 §4.2.3). s-maxage=60 with Age:50 is stored briefly.
	expect((await ask("/aged.json")).status).toBe(200);
	expect((await ask("/aged.json")).status).toBe(200);
	expect(host.hits("/aged.json")).toBe(1);
	// Remaining 2s after Age:1 on s-maxage=3; after that the document is fetched again.
	expect((await ask("/aged-brief.json")).status).toBe(200);
	await new Promise<void>((resolve) => setTimeout(resolve, 2500));
	expect((await ask("/aged-brief.json")).status).toBe(200);
	expect(host.hits("/aged-brief.json")).toBe(2);
	// Age at the freshness lifetime is not stored.
	expect((await ask("/aged-out.json")).status).toBe(200);
	expect((await ask("/aged-out.json")).status).toBe(200);
	expect(host.hits("/aged-out.json")).toBe(2);
	// Expires is freshness when max-age/s-maxage are absent. An already-expired value is not stored.
	expect((await ask("/expires-stale.json")).status).toBe(200);
	expect((await ask("/expires-stale.json")).status).toBe(200);
	expect(host.hits("/expires-stale.json")).toBe(2);
	expect((await ask("/expires-fresh.json")).status).toBe(200);
	expect((await ask("/expires-fresh.json")).status).toBe(200);
	expect(host.hits("/expires-fresh.json")).toBe(1);
	// Invalid Expires (including 0) is already stale (RFC 9111 §5.3), not a five-minute fallback.
	expect((await ask("/expires-zero.json")).status).toBe(200);
	expect((await ask("/expires-zero.json")).status).toBe(200);
	expect(host.hits("/expires-zero.json")).toBe(2);
	// Apparent age from Date counts even without Age (RFC 9111 §4.2.3).
	expect((await ask("/apparent-age.json")).status).toBe(200);
	expect((await ask("/apparent-age.json")).status).toBe(200);
	expect(host.hits("/apparent-age.json")).toBe(2);
	// Vary: * never matches a later request (RFC 9111 §4.1).
	expect((await ask("/vary-star.json")).status).toBe(200);
	expect((await ask("/vary-star.json")).status).toBe(200);
	expect(host.hits("/vary-star.json")).toBe(2);
	// Quoted s-maxage/max-age are accepted (RFC 9111 §5.2). Zero is not stored; a positive quoted s-maxage is.
	expect((await ask("/quoted-zero.json")).status).toBe(200);
	expect((await ask("/quoted-zero.json")).status).toBe(200);
	expect(host.hits("/quoted-zero.json")).toBe(2);
	expect((await ask("/quoted-age.json")).status).toBe(200);
	expect((await ask("/quoted-age.json")).status).toBe(200);
	expect(host.hits("/quoted-age.json")).toBe(1);
	// Current age applies to the five-minute fallback too (RFC 9111 §4.2).
	expect((await ask("/heuristic-age.json")).status).toBe(200);
	expect((await ask("/heuristic-age.json")).status).toBe(200);
	expect(host.hits("/heuristic-age.json")).toBe(2);
	// A duplicated freshness directive is stale (RFC 9111 §4.2.1).
	expect((await ask("/duplicate-age.json")).status).toBe(200);
	expect((await ask("/duplicate-age.json")).status).toBe(200);
	expect(host.hits("/duplicate-age.json")).toBe(2);
	// A malformed freshness directive is stale, not a fallback (RFC 9111 §4.2.1).
	expect((await ask("/bogus-s-maxage.json")).status).toBe(200);
	expect((await ask("/bogus-s-maxage.json")).status).toBe(200);
	expect(host.hits("/bogus-s-maxage.json")).toBe(2);
	expect((await ask("/negative-max-age.json")).status).toBe(200);
	expect((await ask("/negative-max-age.json")).status).toBe(200);
	expect(host.hits("/negative-max-age.json")).toBe(2);
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
	expect(page).toContain("You'll go back to <strong>client.test</strong>.</p>");
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
			`You'll go back to <strong>${new URL(redirect).host}</strong>, a program on this computer. Any program here can claim to be Registered client, so connect only if you just started this.`,
		);
	}
	expect(
		await refused(
			await consent(app, cookie, authorizeQuery(clientId, challenge, { redirect_uri: "http://127.0.0.1:53682/other" })),
		),
	).toBe("redirect_uri is not registered for this client.");
	// Loopback matching may differ only in the port, not a normalized path (RFC 8252 §8.4).
	expect(
		await refused(
			await consent(
				app,
				cookie,
				authorizeQuery(clientId, challenge, { redirect_uri: "http://localhost/a/../callback" }),
			),
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

it("lets a registration lapse after an hour unless a human approves it, and evicts the oldest past the cap", async (test) => {
	const { fixture, app, cookie } = await installed(test, false);
	const registered = async (name: string) => {
		const response = await fetch(`${app.url}/mcp/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: name, redirect_uris: ["https://client.test/callback"] }),
		});
		expect(response.status, name).toBe(201);
		return decode(Schema.Struct({ client_id: Schema.String }), await response.json()).client_id;
	};
	const clients = async () =>
		decode(
			Schema.Array(Schema.Struct({ id: Schema.String, expires_at: Schema.Finite })),
			await fixture.sql("SELECT id,expires_at FROM example_mcp_oauth WHERE kind='client'"),
		);
	const expiry = async (id: string) => (await clients()).find((row) => row.id === id)?.expires_at;
	const waitingCount = async () => (await clients()).filter((row) => row.expires_at > 0).length;
	const hour = 60 * 60 * 1000;
	const { challenge } = pkce("lapse");

	const before = Date.now();
	const waiting = await registered("Waiting client");
	expect(await expiry(waiting)).toBeGreaterThanOrEqual(before + hour);
	expect(await expiry(waiting)).toBeLessThanOrEqual(Date.now() + hour);
	// Approving it at consent keeps it for good, with or without editing. Denying is not approving.
	const approved = await registered("Approved client");
	callback(
		await decide(app, cookie, authorizeQuery(approved, challenge), { decision: "approve", agent: "approved-bot" }),
	);
	expect(await expiry(approved)).toBe(0);
	const editing = await registered("Editing client");
	editingStep(
		await decide(app, cookie, authorizeQuery(editing, challenge), {
			decision: "approve",
			agent: "editing-bot",
			editing: "1",
		}),
	);
	expect(await expiry(editing)).toBe(0);
	const denied = await registered("Denied client");
	callback(await decide(app, cookie, authorizeQuery(denied, challenge), { decision: "deny" }));
	expect(await expiry(denied)).toBeGreaterThan(0);

	// An hour on, an unapproved registration is gone: consent refuses it, then the next registration purges it.
	await fixture.sql(`UPDATE example_mcp_oauth SET expires_at=1 WHERE id IN ('${waiting}','${denied}')`);
	expect(await refused(await consent(app, cookie, authorizeQuery(waiting, challenge)))).toBe(
		"client_id is not registered with this board.",
	);
	expect(
		await refused(await decide(app, cookie, authorizeQuery(denied, challenge), { decision: "approve", agent: "late" })),
	).toBe("client_id is not registered with this board.");

	// A generation from before approvals kept clients, run again after a rollback, approves without keeping. A lapsed
	// registration that a token names still works, and the next registration keeps it instead of purging it.
	const rolledBack = await registered("Rolled back client");
	await fixture.sql(
		`INSERT INTO example_mcp_oauth(id,kind,client_id,family,payload,expires_at,created_at) VALUES('${"e".repeat(64)}','refresh','${rolledBack}','rolled-back','{"resource":"https://comms.test/mcp","scopes":["read","write"],"subject":"rahul","agent":"old-bot"}',${Date.now() + hour},${Date.now()})`,
	);
	await fixture.sql(`UPDATE example_mcp_oauth SET expires_at=1 WHERE id='${rolledBack}'`);
	expect((await consent(app, cookie, authorizeQuery(rolledBack, challenge))).status).toBe(200);
	const purging = await registered("Purging client");
	const kept = (await clients()).map((row) => row.id);
	expect(kept).not.toContain(waiting);
	expect(kept).not.toContain(denied);
	expect(kept).toEqual(expect.arrayContaining([approved, editing, rolledBack, purging]));
	expect(await expiry(rolledBack)).toBe(0);
	// An approved client still connects after any number of purges.
	callback(
		await decide(app, cookie, authorizeQuery(approved, challenge), { decision: "approve", agent: "approved-bot" }),
	);

	// At most 500 wait at once. Past that a registration still succeeds and evicts the oldest waiting one, so a burst
	// only pushes out other unapproved registrations; approved clients never count and are never evicted.
	const soon = Date.now() + hour / 2;
	const fillers = Array.from({ length: 500 - (await waitingCount()) }, (_, index) => `mcp_client_filler${index}`);
	await fixture.sql(
		`INSERT INTO example_mcp_oauth(id,kind,client_id,family,payload,expires_at,created_at) VALUES ${fillers
			.map(
				(id, index) =>
					`('${id}','client','${id}','','{"client_name":"Filler","redirect_uris":["https://client.test/callback"]}',${soon + index},${Date.now()})`,
			)
			.join(",")}`,
	);
	expect(await waitingCount()).toBe(500);
	const over = await registered("Over the cap");
	expect(await waitingCount()).toBe(500);
	expect(await expiry("mcp_client_filler0")).toBeUndefined();
	expect(await expiry(over)).toBeGreaterThan(0);
	await registered("Over again");
	expect(await expiry("mcp_client_filler1")).toBeUndefined();
	expect(await waitingCount()).toBe(500);
	expect((await clients()).map((row) => row.id)).toEqual(expect.arrayContaining([approved, editing, rolledBack]));
	// An evicted registration is gone like a lapsed one.
	expect(await refused(await consent(app, cookie, authorizeQuery("mcp_client_filler0", challenge)))).toBe(
		"client_id is not registered with this board.",
	);
}, 60000);

it("offers a client's name as its posting name without a trailing (chirp)", () => {
	// Claude Code names itself after the server it connects to, so on a board named chirp it registers this way.
	expect(suggestedAgent("Claude Code (chirp)", "rahul")).toBe("claude-code");
	expect(suggestedAgent("Claude Code(chirp)", "rahul")).toBe("claude-code");
	expect(suggestedAgent("Claude Code (Chirp) ", "rahul")).toBe("claude-code");
	expect(suggestedAgent("ChatGPT", "rahul")).toBe("chatgpt");
	expect(suggestedAgent("chirp (beta)", "rahul")).toBe("chirp-beta");
	expect(suggestedAgent("(chirp)", "rahul")).toBe("chirp");
	expect(suggestedAgent("System (chirp)", "rahul")).toBe("mcp");
	// The board's human is whoever is consenting, so their own name is never offered.
	expect(suggestedAgent("Alice (chirp)", "alice")).toBe("mcp");
	expect(suggestedAgent("Rahul", "alice")).toBe("rahul");
});

it("reloads a cross-site consent link once from the board, so a signed-in human skips signing in", async (test) => {
	const { app, cookie } = await installed(test, false);
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Claude Code (chirp)", redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = decode(Schema.Struct({ client_id: Schema.String }), await registration.json()).client_id;
	const query = authorizeQuery(clientId, pkce("bounce").challenge);
	const authorize = (path: string, headers: Readonly<Record<string, string>>) =>
		fetch(`${app.url}${path}`, { redirect: "manual", headers });
	const signsIn = (response: Response) => {
		expect(response.status).toBe(302);
		const login = new URL(response.headers.get("location") ?? "", app.url);
		expect(login.pathname).toBe("/auth/login");
		return new URL(login.searchParams.get("next") ?? "", app.url);
	};

	// A link from the client's site arrives without boot's SameSite=Strict cookie, so the board loads it again itself.
	const crossSite = await authorize(`/mcp/oauth/authorize?${query}`, { "sec-fetch-site": "cross-site" });
	expect(crossSite.status).toBe(200);
	expect(crossSite.headers.get("content-security-policy")).toBe(
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
	);
	// As on boot's own bounce page. A page without a form sends no referrer at all.
	expect(crossSite.headers.get("referrer-policy")).toBe("no-referrer");
	expect(crossSite.headers.get("x-content-type-options")).toBe("nosniff");
	const html = await crossSite.text();
	const next = (/<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1] ?? "").replaceAll("&amp;", "&");
	expect(html).toContain(`<a href="${next.replaceAll("&", "&amp;")}">Continue</a>`);
	const reload = new URL(next, app.url);
	expect(reload.origin + reload.pathname).toBe(`${app.url}/mcp/oauth/authorize`);
	expect(reload.searchParams.get("bounced")).toBe("1");
	reload.searchParams.delete("bounced");
	expect(Object.fromEntries(reload.searchParams)).toEqual(Object.fromEntries(query));

	// That load is same-site, so the cookie rides and consent shows. The marker goes no further than this request.
	const consented = await authorize(next, { cookie, "sec-fetch-site": "same-origin" });
	expect(consented.status).toBe(200);
	const page = await consented.text();
	expect(page).toContain("<h1>Connect Claude Code to chirp</h1>");
	expect(page).toContain('name="agent" value="claude-code"');
	expect(page).not.toContain("bounced");

	// Still signed out after that one load means signed out: sign in as before, never another reload.
	for (const site of ["same-origin", "cross-site"]) {
		const returnsTo = signsIn(await authorize(next, { "sec-fetch-site": site }));
		expect(returnsTo.pathname).toBe("/mcp/oauth/authorize");
		expect(returnsTo.searchParams.has("bounced")).toBe(false);
		expect(Object.fromEntries(returnsTo.searchParams)).toEqual(Object.fromEntries(query));
	}
	// Any other navigation already carries the cookie, so without a session it goes straight to sign-in.
	for (const headers of [
		{ "sec-fetch-site": "same-origin" },
		{ "sec-fetch-site": "same-site" },
		{ "sec-fetch-site": "none" },
		{},
	])
		signsIn(await authorize(`/mcp/oauth/authorize?${query}`, headers));
	// A session that does arrive cross-site goes straight to consent.
	const signedIn = await authorize(`/mcp/oauth/authorize?${query}`, { cookie, "sec-fetch-site": "cross-site" });
	expect(signedIn.status).toBe(200);
	expect(await signedIn.text()).toContain("<h1>Connect Claude Code to chirp</h1>");
}, 30000);

it("keeps a hostile client name and callback host out of consent's markup and policy", async (test) => {
	const { app, cookie } = await installed(test, false);
	const register = (name: string, redirects: ReadonlyArray<string>) =>
		fetch(`${app.url}/mcp/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: name, redirect_uris: redirects }),
		});
	// The URL parser keeps these characters in a host, and consent writes the callback's origin into its CSP.
	for (const redirect of [
		"https://client.test;script-src*/callback",
		"https://client'test/callback",
		'https://client"test/callback',
		"https://client{test}/callback",
	]) {
		const refusedRegistration = await register("Hostile host", [redirect]);
		expect(refusedRegistration.status, redirect).toBe(400);
		expect(decode(OAuthError, await refusedRegistration.json()).error).toBe("invalid_client_metadata");
	}
	// An IDN, which the parser turns into punycode, and an IPv6 loopback still register.
	expect((await register("Plain hosts", ["https://bücher.example/callback", "http://[::1]/callback"])).status).toBe(
		201,
	);

	const name = `</title><script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
	const registration = await register(name, ["https://client.test/callback", "http://[::1]/callback"]);
	expect(registration.status).toBe(201);
	const clientId = decode(Schema.Struct({ client_id: Schema.String }), await registration.json()).client_id;
	for (const [redirect, origin] of [
		["https://client.test/callback", "https://client.test"],
		["http://[::1]:5555/callback", "http://[::1]:5555"],
	] as const) {
		const page = await consent(
			app,
			cookie,
			authorizeQuery(clientId, pkce("hostile").challenge, { redirect_uri: redirect }),
		);
		expect(page.status, redirect).toBe(200);
		const html = await page.text();
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
		// One script, the page's own; the name shows only escaped.
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(html).not.toContain("<img");
		expect(html).toContain(
			"<h1>Connect &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp; to chirp</h1>",
		);
		expect(html).toContain(
			"<title>Connect &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp; · chirp</title>",
		);
		expect(page.headers.get("content-security-policy")).toBe(
			`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256")
				.update(scripts[0] ?? "")
				.digest("base64")}'; form-action 'self' ${origin}; base-uri 'none'; frame-ancestors 'none'`,
		);
	}
}, 30000);

it("lets boot refuse a consent or continue post from anywhere but the board", async (test) => {
	const { fixture, app, cookie } = await installed(test, false);
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Origin client", redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = decode(Schema.Struct({ client_id: Schema.String }), await registration.json()).client_id;
	const post = (path: string, origin: string | undefined, fields: Readonly<Record<string, string>>) =>
		fetch(`${app.url}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: {
				cookie,
				"content-type": "application/x-www-form-urlencoded",
				...(origin === undefined ? {} : { origin }),
			},
			body: new URLSearchParams(fields),
		});
	const refusedBy = async (response: Response) => {
		expect(response.status).toBe(403);
		return decode(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }), await response.json()).error.code;
	};
	// A browser sends Origin: null from a sandboxed frame or under a no-referrer policy.
	const elsewhere = ["https://evil.test", undefined, "null", "https://comms.test.evil.test"];
	const approve = {
		...Object.fromEntries(authorizeQuery(clientId, pkce("origin").challenge)),
		decision: "approve",
		agent: "origin-bot",
		editing: "1",
	};
	for (const origin of elsewhere)
		expect(await refusedBy(await post("/mcp/oauth/authorize", origin, approve)), String(origin)).toBe("origin_invalid");
	// None reached the extension: nothing was issued or stored for the client.
	expect(
		await fixture.sql(`SELECT kind FROM example_mcp_oauth WHERE client_id='${clientId}' AND kind<>'client'`),
	).toEqual([]);
	const step = editingStep(await post("/mcp/oauth/authorize", "https://comms.test", approve));
	for (const origin of elsewhere)
		for (const decision of ["connect", "cancel"])
			expect(
				await refusedBy(await post("/mcp/oauth/continue", origin, { consent: step.consent, decision })),
				`${String(origin)} ${decision}`,
			).toBe("origin_invalid");
	// The continuation is untouched, so the board's own post still finishes connecting.
	expect(
		callback(await post("/mcp/oauth/continue", "https://comms.test", { consent: step.consent })).searchParams.get(
			"code",
		),
	).toMatch(/^mcp_code_/);
}, 30000);
