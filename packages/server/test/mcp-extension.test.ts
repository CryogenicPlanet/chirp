import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { cp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
import { publicCallbackAddress } from "./fixtures/mcp-callback-addresses.ts";

const stringField = (value: unknown, name: string) => {
	if (typeof value !== "object" || value === null) throw new Error(`${name} response is not an object`);
	const field = Reflect.get(value, name);
	if (typeof field !== "string") throw new Error(`${name} is not a string`);
	return field;
};

it("keeps MCP absent until its extension package is installed", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch(join(import.meta.dirname, "../src/server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(`${app.url}/mcp`, { headers: { cookie } })).status).toBeGreaterThanOrEqual(400);
}, 20000);

const installed = async (test: TestContext, mcpOrigin?: string, localCallbacks = false) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await cp(join(import.meta.dirname, "../../../examples/extensions/mcp"), join(seed, "ext/mcp"), { recursive: true });
	for (const file of ["index.ts", "oauth.ts", "tools.ts", "events.ts"]) {
		const path = join(seed, `ext/mcp/${file}`);
		const source = (await readFile(path, "utf8"))
			.replace("../../../packages/server/src/kernel/extension-api.ts", "../../kernel/extension-api.ts")
			.replace("https://your-board.example", "https://comms.test")
			.replace("const allowLocalCallbacks = false;", `const allowLocalCallbacks = ${localCallbacks};`);
		await writeFile(
			path,
			mcpOrigin === undefined
				? source
				: source.replace("const mcpOrigin = boardOrigin;", `const mcpOrigin = ${JSON.stringify(mcpOrigin)};`),
		);
	}
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	return { fixture, app, cookie };
};

it("serves MCP at a separate origin while consent stays on the board origin", async (test) => {
	const { app, cookie } = await installed(test, "https://mcp.test");
	expect(await (await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`)).json()).toMatchObject({
		resource: "https://mcp.test/mcp",
		authorization_servers: ["https://comms.test"],
	});
	expect(await (await fetch(`${app.url}/.well-known/oauth-authorization-server`)).json()).toMatchObject({
		issuer: "https://comms.test",
		authorization_endpoint: "https://comms.test/mcp/oauth/authorize",
	});
	const call = (headers: Record<string, string>) =>
		fetch(`${app.url}/mcp`, {
			method: "POST",
			headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
	expect((await call({})).headers.get("www-authenticate")).toContain(
		'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
	);
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Split client", redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = stringField(await registration.json(), "client_id");
	const verifier = createHash("sha256").update("split-verifier").digest("base64url");
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource: "https://comms.test/mcp",
		scope: "read",
	});
	const mismatched = await fetch(`${app.url}/mcp/oauth/authorize?${query}`, { headers: { cookie } });
	expect(mismatched.status).toBe(400);
	expect(await mismatched.json()).toMatchObject({
		error: "invalid_request",
		error_description: "resource must be https://mcp.test/mcp; connect the client to exactly that URL.",
	});
	query.set("resource", "https://mcp.test/mcp");
	expect((await fetch(`${app.url}/mcp/oauth/authorize?${query}`, { headers: { cookie } })).status).toBe(200);
	const approval = await fetch(`${app.url}/mcp/oauth/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve", agent: "split-client" }),
	});
	const code = new URL(approval.headers.get("location") ?? "").searchParams.get("code");
	if (!code) throw new Error("authorization code is missing");
	const exchanged = await fetch(`${app.url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			redirect_uri: "https://client.test/callback",
			resource: "https://mcp.test/mcp",
			code,
			code_verifier: verifier,
		}),
	});
	expect(exchanged.status).toBe(200);
	const access = stringField(await exchanged.json(), "access_token");
	expect((await call({ authorization: `Bearer ${access}`, origin: "https://mcp.test" })).status).toBe(200);
}, 30000);

it("serves extension-owned OAuth and stateless, scoped MCP tools", async (test) => {
	const { fixture, app, cookie } = await installed(test);

	const metadata = await (await fetch(`${app.url}/.well-known/oauth-protected-resource/mcp`)).json();
	expect(metadata).toMatchObject({
		resource: "https://comms.test/mcp",
		authorization_servers: ["https://comms.test"],
		scopes_supported: ["read", "write"],
	});
	const server = await (await fetch(`${app.url}/.well-known/oauth-authorization-server`)).json();
	expect(server).toMatchObject({
		authorization_endpoint: "https://comms.test/mcp/oauth/authorize",
		token_endpoint: "https://comms.test/mcp/oauth/token",
		registration_endpoint: "https://comms.test/mcp/oauth/register",
		code_challenge_methods_supported: ["S256"],
	});
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "MCP test client",
			redirect_uris: ["https://client.test/callback"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(registration.status).toBe(201);
	const clientId = stringField(await registration.json(), "client_id");
	const wrongTarget = await fetch(`${app.url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: "unknown",
			resource: "https://other.test/mcp",
		}),
	});
	expect(wrongTarget.status).toBe(400);
	expect(await wrongTarget.json()).toMatchObject({ error: "invalid_target" });

	const grant = async (
		scope: "read" | "read write",
		marker: string,
		grantedClientId = clientId,
		clientName = "MCP test client",
		agent = "writer-bot",
	) => {
		const verifier = createHash("sha256").update(`verifier-${marker}`).digest("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const query = new URLSearchParams({
			response_type: "code",
			client_id: grantedClientId,
			redirect_uri: "https://client.test/callback",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: "https://comms.test/mcp",
			scope,
			state: marker,
		});
		const authorize = `/mcp/oauth/authorize?${query}`;
		const signedOut = await fetch(`${app.url}${authorize}`, { redirect: "manual" });
		expect(signedOut.status).toBe(302);
		expect(signedOut.headers.get("location")).toContain("/auth/login?next=");
		const consent = await fetch(`${app.url}${authorize}`, { headers: { cookie } });
		expect(consent.status).toBe(200);
		expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' https://client.test;");
		const page = await consent.text();
		expect(page).toContain(`Authorize ${clientName}`);
		// A client asking for read alone is still granted write, so consent always asks who it posts as.
		expect(page).toContain("This client is requesting: read, write.");
		expect(page).toContain(`name="agent" value="${clientName.toLowerCase().replaceAll(" ", "-")}"`);
		const approvalBody = { ...Object.fromEntries(query), decision: "approve", agent };
		if (marker === "writer")
			for (const unnamed of [
				{},
				{ agent: "system" },
				{ agent: "rahul" },
				{ agent: "Writer Bot" },
				{ agent: "a".repeat(65) },
			]) {
				const refused = await fetch(`${app.url}/mcp/oauth/authorize`, {
					method: "POST",
					redirect: "manual",
					headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve", ...unnamed }),
				});
				expect(refused.status).toBe(400);
			}
		if (marker === "reader") {
			const missingOrigin = await fetch(`${app.url}/mcp/oauth/authorize`, {
				method: "POST",
				redirect: "manual",
				headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(approvalBody),
			});
			expect(missingOrigin.status).toBe(403);
		}
		const approval = await fetch(`${app.url}/mcp/oauth/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(approvalBody),
		});
		expect(approval.status).toBe(302);
		const callback = new URL(approval.headers.get("location") ?? "");
		expect(callback.origin + callback.pathname).toBe("https://client.test/callback");
		expect(callback.searchParams.get("state")).toBe(marker);
		const code = callback.searchParams.get("code");
		if (!code) throw new Error("authorization code is missing");
		if (marker === "reader")
			expect(JSON.stringify(await fixture.sql("SELECT * FROM example_mcp_oauth"))).not.toContain(code);
		const exchange = (codeVerifier = verifier) =>
			fetch(`${app.url}/mcp/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: grantedClientId,
					redirect_uri: "https://client.test/callback",
					resource: "https://comms.test/mcp",
					code,
					code_verifier: codeVerifier,
				}),
			});
		if (marker === "reader") expect((await exchange("short")).status).toBe(400);
		const exchanged = await exchange();
		expect(exchanged.status).toBe(200);
		const tokens = await exchanged.json();
		expect(tokens).toMatchObject({ scope: "read write" });
		expect((await exchange()).status).toBe(400);
		return {
			access: stringField(tokens, "access_token"),
			refresh: stringField(tokens, "refresh_token"),
		};
	};
	const reader = await grant("read", "reader");
	const writer = await grant("read write", "writer");
	const call = (token: string, id: number, method: string, params?: unknown, version = "2025-11-25") =>
		fetch(`${app.url}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": version,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
		});

	const unauthorized = await call("chirp_app_" + "a".repeat(43), 0, "ping");
	expect(unauthorized.status).toBe(401);
	expect(unauthorized.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
	expect(unauthorized.headers.get("www-authenticate")).toContain('scope="read write"');
	expect(
		(
			await fetch(`${app.url}/mcp`, {
				method: "POST",
				headers: {
					cookie,
					origin: "https://comms.test",
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
			})
		).status,
	).toBe(401);
	const initialized = await (
		await call(reader.access, 1, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		})
	).json();
	expect(initialized.result).toMatchObject({
		protocolVersion: "2025-11-25",
		capabilities: { tools: { listChanged: false } },
	});
	const listed = await (await call(reader.access, 2, "tools/list")).json();
	expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
		"search",
		"fetch",
		"read_topic",
		"post_message",
	]);
	expect((await call(reader.access, 20, "ping", undefined, "1900-01-01")).status).toBe(400);
	const events = await fetch(`${app.url}/mcp`, {
		headers: { authorization: `Bearer ${reader.access}`, accept: "text/event-stream" },
	});
	expect(events.status).toBe(405);
	expect(events.headers.get("allow")).toBe("POST");

	const created = await app.post(
		"/api/messages",
		{ topic: "plans", body: "Quarterly launch plan", tags: ["planning"] },
		cookie,
	);
	const message = await created.json();
	const seq = Reflect.get(message, "seq");
	if (typeof seq !== "number") throw new Error("created message has no sequence");
	const searched = await (
		await call(reader.access, 3, "tools/call", {
			name: "search",
			arguments: { query: "quarterly launch" },
			_meta: { progressToken: 3 },
		})
	).json();
	expect(searched.result.structuredContent.results).toContainEqual({
		id: `message:${seq}`,
		title: expect.stringContaining("Quarterly launch plan"),
		url: `https://comms.test/?message=${seq}#message-${seq}`,
	});
	const fetched = await (
		await call(reader.access, 4, "tools/call", { name: "fetch", arguments: { id: `message:${seq}` } })
	).json();
	expect(fetched.result.structuredContent).toMatchObject({
		id: `message:${seq}`,
		text: "Quarterly launch plan",
		metadata: { topic: "plans", tags: ["planning"] },
	});
	// Grants issued before write existed stay read-only until the client reconnects.
	const readOnly = `chirp_app_${"R".repeat(43)}`;
	await fixture.sql(
		`INSERT INTO example_mcp_oauth(id,kind,client_id,family,payload,expires_at,created_at) VALUES('${createHash("sha256").update(readOnly).digest("hex")}','access','${clientId}','read-only','{"resource":"https://comms.test/mcp","scopes":["read"],"subject":"rahul"}',${Date.now() + 3600000},${Date.now()})`,
	);
	const denied = await (
		await call(readOnly, 5, "tools/call", {
			name: "post_message",
			arguments: { topic: "plans", body: "Reader must not post", idempotencyKey: "reader-post" },
		})
	).json();
	expect(denied.result).toMatchObject({
		isError: true,
		content: [{ text: expect.stringContaining("scope_required") }],
	});
	const post = {
		name: "post_message",
		arguments: { topic: "plans", body: "Approved via MCP", idempotencyKey: "mcp-post-1" },
	};
	const legacy = `chirp_app_${"L".repeat(43)}`;
	await fixture.sql(
		`INSERT INTO example_mcp_oauth(id,kind,client_id,family,payload,expires_at,created_at) VALUES('${createHash("sha256").update(legacy).digest("hex")}','access','${clientId}','legacy','{"resource":"https://comms.test/mcp","scopes":["read","write"],"subject":"rahul"}',${Date.now() + 3600000},${Date.now()})`,
	);
	expect((await (await call(legacy, 23, "tools/call", post)).json()).result).toMatchObject({
		isError: true,
		content: [{ text: expect.stringContaining("no posting name") }],
	});
	const first = await (await call(writer.access, 6, "tools/call", post)).json();
	const replay = await (await call(writer.access, 7, "tools/call", post)).json();
	expect(first.result.structuredContent).toMatchObject({
		topic: "plans",
		body: "Approved via MCP",
		agent: "writer-bot",
		instance: `extension:mcp:${clientId}`,
		meta: { mcp_client_id: clientId, mcp_approved_by: "rahul" },
	});
	expect(replay.result.structuredContent.id).toBe(first.result.structuredContent.id);
	const otherClient = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Other client", redirect_uris: ["https://client.test/callback"] }),
	});
	expect(otherClient.status).toBe(201);
	const otherClientId = stringField(await otherClient.json(), "client_id");
	const ownerNamed = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Rahul", redirect_uris: ["https://client.test/callback"] }),
	});
	const ownerNamedConsent = await fetch(
		`${app.url}/mcp/oauth/authorize?${new URLSearchParams({
			response_type: "code",
			client_id: stringField(await ownerNamed.json(), "client_id"),
			redirect_uri: "https://client.test/callback",
			code_challenge: "a".repeat(43),
			code_challenge_method: "S256",
			resource: "https://comms.test/mcp",
		})}`,
		{ headers: { cookie } },
	);
	const ownerNamedPage = await ownerNamedConsent.text();
	expect(ownerNamedPage).toContain("requesting: read, write.");
	expect(ownerNamedPage).toContain('name="agent" value="mcp"');
	const otherWriter = await grant("read write", "other-writer", otherClientId, "Other client", "other-bot");
	const separate = await (await call(otherWriter.access, 8, "tools/call", post)).json();
	expect(separate.result.structuredContent.id).not.toBe(first.result.structuredContent.id);
	expect(separate.result.structuredContent.agent).toBe("other-bot");

	const refresh = (token: string) =>
		fetch(`${app.url}/mcp/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: clientId,
				refresh_token: token,
				resource: "https://comms.test/mcp",
			}),
		});
	const rotatedWriter = await refresh(writer.refresh);
	expect(rotatedWriter.status).toBe(200);
	const afterRotation = await (
		await call(stringField(await rotatedWriter.json(), "access_token"), 22, "tools/call", {
			name: "post_message",
			arguments: { topic: "plans", body: "After rotation", idempotencyKey: "mcp-post-2" },
		})
	).json();
	expect(afterRotation.result.structuredContent.agent).toBe("writer-bot");
	const refreshed = await refresh(reader.refresh);
	expect(refreshed.status).toBe(200);
	const rotated = await refreshed.json();
	const rotatedAccess = stringField(rotated, "access_token");
	const rotatedRefresh = stringField(rotated, "refresh_token");
	expect(rotatedAccess).toMatch(/^chirp_app_[A-Za-z0-9_-]{43}$/);
	expect((await refresh(reader.refresh)).status).toBe(400);
	expect((await call(rotatedAccess, 21, "ping")).status).toBe(401);
	expect((await refresh(rotatedRefresh)).status).toBe(400);
	expect(
		(
			await fetch(`${app.url}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${writer.access}`,
					origin: "https://evil.test",
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
			})
		).status,
	).toBe(403);
	const rows = Schema.decodeUnknownSync(
		Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, payload: Schema.String })),
	)(await fixture.sql("SELECT id,kind,payload FROM example_mcp_oauth"));
	const stored = JSON.stringify(rows);
	for (const credential of [
		reader.access,
		reader.refresh,
		writer.access,
		writer.refresh,
		otherWriter.access,
		otherWriter.refresh,
	])
		expect(stored).not.toContain(credential);
	for (const row of rows) {
		if (Reflect.get(row, "kind") === "client") continue;
		expect(Reflect.get(row, "id")).toMatch(/^[a-f0-9]{64}$/);
	}
}, 60000);

/** Registers a client and approves read and write under `agent`, returning its access token. */
const connect = async (url: string, cookie: string, clientName: string, agent: string) => {
	const registration = await fetch(`${url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: clientName, redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = stringField(await registration.json(), "client_id");
	const verifier = createHash("sha256").update(`verifier-${clientName}`).digest("base64url");
	const query = {
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource: "https://comms.test/mcp",
		scope: "read write",
	};
	const approval = await fetch(`${url}/mcp/oauth/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ ...query, decision: "approve", agent }),
	});
	const code = new URL(approval.headers.get("location") ?? "").searchParams.get("code");
	if (!code) throw new Error("authorization code is missing");
	const exchanged = await fetch(`${url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			redirect_uri: "https://client.test/callback",
			resource: "https://comms.test/mcp",
			code,
			code_verifier: verifier,
		}),
	});
	return { clientId, access: stringField(await exchanged.json(), "access_token") };
};

/** An MCP 2.0 request: version and capabilities travel in `_meta`, mirrored by the standard headers. */
const modern = (
	url: string,
	token: string,
	id: number,
	method: string,
	params: Record<string, unknown> = {},
	options: { readonly headers?: Record<string, string>; readonly version?: string; readonly meta?: object } = {},
) =>
	fetch(`${url}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": options.version ?? "2026-07-28",
			"mcp-method": method,
			...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
			...options.headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: options.meta ?? {
					"io.modelcontextprotocol/protocolVersion": options.version ?? "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});

const hookReceiver = async (test: TestContext) => {
	const received: Array<{
		readonly headers: Readonly<Record<string, string | string[] | undefined>>;
		readonly body: string;
	}> = [];
	const state = { echo: true };
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify(typeof challenge === "string" ? { challenge: state.echo ? challenge : "wrong" } : {}),
			);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	test.onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	return { url: `http://127.0.0.1:${address.port}/hook`, received, state };
};

const signatureOf = (secret: string, headers: Readonly<Record<string, string | string[] | undefined>>, body: string) =>
	`v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(`${String(headers["webhook-id"])}.${String(headers["webhook-timestamp"])}.${body}`)
		.digest("base64")}`;

const eventually = async <A>(check: () => A | undefined) => {
	for (let attempt = 0; attempt < 200; attempt++) {
		const value = check();
		if (value !== undefined) return value;
		await delay(50);
	}
	throw new Error("condition was not met within 10 seconds");
};

it("serves MCP 2.0 discovery and delivers signed mention events to a verified webhook", async (test) => {
	const { app, cookie } = await installed(test, undefined, true);
	const { access } = await connect(app.url, cookie, "Event client", "gpt-bot");
	const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
	const hook = await hookReceiver(test);
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });

	const discovered = await rpc(await modern(app.url, access, 1, "server/discover"));
	expect(discovered.status).toBe(200);
	expect(discovered.body.result).toMatchObject({
		resultType: "complete",
		supportedVersions: ["2026-07-28"],
		capabilities: { tools: {}, events: {} },
		cacheScope: "public",
		_meta: { "io.modelcontextprotocol/serverInfo": { name: "chirp" } },
	});
	expect(discovered.body.result.ttlMs).toBeGreaterThanOrEqual(0);
	expect(
		await rpc(await modern(app.url, access, 2, "server/discover", {}, { headers: { "mcp-method": "tools/list" } })),
	).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
	expect(await rpc(await modern(app.url, access, 3, "server/discover", {}, { version: "2099-01-01" }))).toMatchObject({
		status: 400,
		body: {
			error: { code: -32022, data: { requested: "2099-01-01", supported: expect.arrayContaining(["2026-07-28"]) } },
		},
	});
	expect(
		await rpc(
			await modern(
				app.url,
				access,
				4,
				"server/discover",
				{},
				{
					meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
				},
			),
		),
	).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
	expect(await rpc(await modern(app.url, access, 5, "ping"))).toMatchObject({
		status: 404,
		body: { error: { code: -32601 } },
	});
	expect((await rpc(await modern(app.url, access, 6, "tools/list"))).body.result).toMatchObject({
		resultType: "complete",
		cacheScope: "public",
		tools: expect.arrayContaining([expect.objectContaining({ name: "post_message" })]),
	});
	expect(
		(await rpc(await modern(app.url, access, 7, "tools/call", { name: "search", arguments: { query: "anything" } })))
			.body.result,
	).toMatchObject({ resultType: "complete", structuredContent: { results: [] } });
	expect((await rpc(await modern(app.url, access, 8, "events/list"))).body.result).toMatchObject({
		resultType: "complete",
		events: [{ name: "mention.created", delivery: ["webhook"] }],
	});

	const subscription = (overrides: Record<string, unknown> = {}) => ({
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hook.url, secret },
		cursor: null,
		...overrides,
	});
	for (const [overrides, code] of [
		[{ delivery: { mode: "webhook", url: hook.url, secret: "whsec_short" } }, -32602],
		[{ arguments: { topic: "plans" } }, -32602],
		[{ name: "message.deleted" }, -32011],
		[{ delivery: { mode: "poll", url: hook.url, secret } }, -32014],
	] as const)
		expect(
			(await rpc(await modern(app.url, access, 9, "events/subscribe", subscription(overrides)))).body.error.code,
		).toBe(code);
	hook.state.echo = false;
	expect((await rpc(await modern(app.url, access, 10, "events/subscribe", subscription()))).body.error).toMatchObject({
		code: -32015,
		message: "CallbackEndpointError",
		data: { reason: "challenge_failed" },
	});
	hook.state.echo = true;
	const verificationsBefore = hook.received.length;
	const subscribed = await rpc(await modern(app.url, access, 11, "events/subscribe", subscription()));
	expect(subscribed.body.result).toMatchObject({ resultType: "complete", cursor: null, truncated: false });
	const subscriptionId = subscribed.body.result.id;
	expect(subscriptionId).toMatch(/^sub_[0-9a-f]{32}$/);
	expect(Date.parse(subscribed.body.result.refreshBefore)).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
	const verification = hook.received[verificationsBefore];
	if (!verification) throw new Error("verification was not sent");
	expect(JSON.parse(verification.body)).toMatchObject({ type: "verification", challenge: expect.any(String) });
	expect(verification.headers["webhook-id"]).toMatch(/^msg_verification_/);
	expect(verification.headers["x-mcp-subscription-id"]).toBe(subscriptionId);
	expect(verification.headers["webhook-signature"]).toBe(signatureOf(secret, verification.headers, verification.body));

	const refreshed = await rpc(await modern(app.url, access, 12, "events/subscribe", subscription({ ttlMs: 60_000 })));
	expect(refreshed.body.result.id).toBe(subscriptionId);
	expect(Date.parse(refreshed.body.result.refreshBefore)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
	expect(hook.received.length).toBe(verificationsBefore + 1);

	const deliveries = () => hook.received.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"));
	const mentioned = await (
		await app.post("/api/messages", { topic: "plans", body: "Ship it, @gpt-bot?" }, cookie)
	).json();
	const first = await eventually(() => deliveries()[0]);
	expect(first.headers["webhook-signature"]).toBe(signatureOf(secret, first.headers, first.body));
	expect(first.headers["x-mcp-subscription-id"]).toBe(subscriptionId);
	expect(JSON.parse(first.body)).toEqual({
		eventId: `evt_${mentioned.seq}`,
		name: "mention.created",
		timestamp: new Date(mentioned.created_at).toISOString(),
		data: {
			id: `message:${mentioned.seq}`,
			topic: "plans",
			author: "rahul",
			text: "Ship it, @gpt-bot?",
			truncated: false,
			url: `https://comms.test/?message=${mentioned.seq}#message-${mentioned.seq}`,
		},
		cursor: null,
	});
	expect(first.headers["webhook-id"]).toBe(`evt_${mentioned.seq}`);

	await app.post("/api/messages", { topic: "plans", body: "Nobody is mentioned here" }, cookie);
	await modern(app.url, access, 13, "tools/call", {
		name: "post_message",
		arguments: { topic: "plans", body: "Noting this for @gpt-bot", idempotencyKey: "own-mention" },
	});
	const everyone = await (await app.post("/api/messages", { topic: "plans", body: "@here standup" }, cookie)).json();
	const second = await eventually(() => deliveries()[1]);
	expect(JSON.parse(second.body).data.id).toBe(`message:${everyone.seq}`);
	expect(deliveries()).toHaveLength(2);

	expect(
		(
			await rpc(
				await modern(app.url, access, 14, "events/unsubscribe", {
					name: "mention.created",
					arguments: {},
					delivery: { mode: "webhook", url: hook.url },
				}),
			)
		).body.result,
	).toEqual({ resultType: "complete" });
	expect(
		(
			await rpc(
				await modern(app.url, access, 15, "events/unsubscribe", {
					name: "mention.created",
					delivery: { url: hook.url },
				}),
			)
		).body.result,
	).toEqual({ resultType: "complete" });
	await app.post("/api/messages", { topic: "plans", body: "Still there, @gpt-bot?" }, cookie);
	await delay(1500);
	expect(deliveries()).toHaveLength(2);
}, 60000);

it("stops delivering pending mentions when unsubscribe is called during drain", async (test) => {
	const { fixture, app, cookie } = await installed(test, undefined, true);
	const { access, clientId } = await connect(app.url, cookie, "Drain client", "drain-bot");
	const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;

	// Create a slow receiver that introduces delay to keep drain active longer
	const received: Array<{
		readonly headers: Readonly<Record<string, string | string[] | undefined>>;
		readonly body: string;
	}> = [];
	const slowServer = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			// Introduce a delay to simulate slow processing
			await delay(500);
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	slowServer.listen(0, "127.0.0.1");
	await once(slowServer, "listening");
	test.onTestFinished(async () => {
		slowServer.closeAllConnections();
		await new Promise<void>((resolve) => slowServer.close(() => resolve()));
	});
	const address = slowServer.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const hookUrl = `http://127.0.0.1:${address.port}/hook`;

	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });

	const subscription = {
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hookUrl, secret },
		cursor: null,
	};
	const subscribed = await rpc(await modern(app.url, access, 1, "events/subscribe", subscription));
	expect(subscribed.body.result.id).toMatch(/^sub_[0-9a-f]{32}$/);

	const deliveries = () => received.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"));

	// Post multiple mentions to create a backlog
	for (let n = 1; n <= 10; n++) {
		await app.post("/api/messages", { topic: "plans", body: `Mention ${n} for @drain-bot` }, cookie);
	}

	// Wait for the first delivery to confirm drain is active
	await eventually(() => deliveries()[0]);

	// Unsubscribe while the drain is still processing the backlog
	const unsubscribed = await rpc(
		await modern(app.url, access, 2, "events/unsubscribe", {
			name: "mention.created",
			delivery: { url: hookUrl },
		}),
	);
	expect(unsubscribed.body.result).toEqual({ resultType: "complete" });

	// Wait to ensure no more deliveries happen after unsubscribe
	await delay(3000);

	// Verify the subscription row is deleted
	const rows = (await fixture.sql(
		`SELECT COUNT(*) AS count FROM example_mcp_events WHERE client_id='${clientId}'`,
	)) as Array<{ count: number }>;
	expect(rows[0]?.count).toBe(0);

	// There should be at most a few deliveries (those that were already in flight), not all 10
	const finalCount = deliveries().length;
	expect(finalCount).toBeLessThan(10);
	expect(finalCount).toBeGreaterThan(0); // At least one was delivered before unsubscribe

	const resubscribed = await rpc(await modern(app.url, access, 3, "events/subscribe", subscription));
	expect(resubscribed.body.result.id).toMatch(/^sub_[0-9a-f]{32}$/);
	for (let n = 1; n <= 8; n++) {
		await app.post("/api/messages", { topic: "plans", body: `Grant ${n} for @drain-bot` }, cookie);
	}
	await eventually(() => (deliveries().length > finalCount ? true : undefined));
	await fixture.sql(
		`UPDATE example_mcp_oauth SET expires_at=0 WHERE client_id='${clientId}' AND (kind='access' OR kind='refresh')`,
	);
	await delay(2000);
	const afterGrantLoss = deliveries().length;
	await delay(2000);
	expect(deliveries().length).toBe(afterGrantLoss);
}, 40000);

it("signs deliveries with both secrets while a refresh rotates the webhook key", async (test) => {
	const { app, cookie } = await installed(test, undefined, true);
	const { access } = await connect(app.url, cookie, "Rotate client", "rotate-bot");
	const oldSecret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
	const newSecret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
	const received: Array<{
		readonly headers: Readonly<Record<string, string | string[] | undefined>>;
		readonly body: string;
	}> = [];
	const slowServer = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			await delay(400);
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	slowServer.listen(0, "127.0.0.1");
	await once(slowServer, "listening");
	test.onTestFinished(async () => {
		slowServer.closeAllConnections();
		await new Promise<void>((resolve) => slowServer.close(() => resolve()));
	});
	const address = slowServer.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const hookUrl = `http://127.0.0.1:${address.port}/hook`;
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });
	const params = (secret: string) => ({
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hookUrl, secret },
		cursor: null,
	});
	expect((await rpc(await modern(app.url, access, 1, "events/subscribe", params(oldSecret)))).body.result.id).toMatch(
		/^sub_[0-9a-f]{32}$/,
	);
	const deliveries = () => received.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"));
	const signedWith = (item: (typeof received)[number], ...secrets: string[]) =>
		item.headers["webhook-signature"] ===
		secrets.map((secret) => signatureOf(secret, item.headers, item.body)).join(" ");
	for (let n = 1; n <= 8; n++) {
		await app.post("/api/messages", { topic: "plans", body: `Rotate ${n} for @rotate-bot` }, cookie);
	}
	const first = await eventually(() => deliveries()[0]);
	expect(signedWith(first, oldSecret)).toBe(true);
	expect(
		(await rpc(await modern(app.url, access, 2, "events/subscribe", params(newSecret)))).body.result,
	).toMatchObject({ resultType: "complete" });
	const dual = await eventually(() => deliveries().find((item) => signedWith(item, newSecret, oldSecret)));
	expect(dual).toBeDefined();
}, 40000);

it("retires the previous webhook secret after the overlap window", async (test) => {
	const { app, cookie, fixture } = await installed(test, undefined, true);
	const { access, clientId } = await connect(app.url, cookie, "Retire client", "retire-bot");
	const oldSecret = `whsec_${Buffer.alloc(32, 10).toString("base64")}`;
	const newSecret = `whsec_${Buffer.alloc(32, 11).toString("base64")}`;
	const received: Array<{
		readonly headers: Readonly<Record<string, string | string[] | undefined>>;
		readonly body: string;
	}> = [];
	const slowServer = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			await delay(400);
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	slowServer.listen(0, "127.0.0.1");
	await once(slowServer, "listening");
	test.onTestFinished(async () => {
		slowServer.closeAllConnections();
		await new Promise<void>((resolve) => slowServer.close(() => resolve()));
	});
	const address = slowServer.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const hookUrl = `http://127.0.0.1:${address.port}/hook`;
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });
	const params = (secret: string) => ({
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hookUrl, secret },
		cursor: null,
	});
	expect((await rpc(await modern(app.url, access, 1, "events/subscribe", params(oldSecret)))).body.result.id).toMatch(
		/^sub_[0-9a-f]{32}$/,
	);
	await app.post("/api/messages", { topic: "plans", body: "Before rotation for @retire-bot" }, cookie);
	const deliveries = () => received.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"));
	const signedWith = (item: (typeof received)[number], ...secrets: string[]) =>
		item.headers["webhook-signature"] ===
		secrets.map((secret) => signatureOf(secret, item.headers, item.body)).join(" ");
	const before = await eventually(() => deliveries()[0]);
	expect(signedWith(before, oldSecret)).toBe(true);
	expect(
		(await rpc(await modern(app.url, access, 2, "events/subscribe", params(newSecret)))).body.result,
	).toMatchObject({ resultType: "complete" });
	await app.post("/api/messages", { topic: "plans", body: "During overlap for @retire-bot" }, cookie);
	const during = await eventually(() => deliveries().find((item) => signedWith(item, newSecret, oldSecret)));
	expect(during).toBeDefined();
	await fixture.sql(`UPDATE example_mcp_events SET previous_secret_until=0 WHERE client_id='${clientId}'`);
	await app.post("/api/messages", { topic: "plans", body: "After expiry for @retire-bot" }, cookie);
	const after = await eventually(() =>
		deliveries().find((item) => item.body.includes("After expiry") && signedWith(item, newSecret)),
	);
	expect(after).toBeDefined();
	const afterDual = deliveries().find(
		(item) => item.body.includes("After expiry") && signedWith(item, newSecret, oldSecret),
	);
	expect(afterDual).toBeUndefined();
}, 40000);

it("preserves previous secret overlap during same-secret refreshes", async (test) => {
	const { app, cookie } = await installed(test, undefined, true);
	const { access } = await connect(app.url, cookie, "Preserve client", "preserve-bot");
	const secretA = `whsec_${Buffer.alloc(32, 12).toString("base64")}`;
	const secretB = `whsec_${Buffer.alloc(32, 13).toString("base64")}`;
	const received: Array<{
		readonly headers: Readonly<Record<string, string | string[] | undefined>>;
		readonly body: string;
	}> = [];
	const slowServer = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			await delay(400);
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	slowServer.listen(0, "127.0.0.1");
	await once(slowServer, "listening");
	test.onTestFinished(async () => {
		slowServer.closeAllConnections();
		await new Promise<void>((resolve) => slowServer.close(() => resolve()));
	});
	const address = slowServer.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const hookUrl = `http://127.0.0.1:${address.port}/hook`;
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });
	const params = (secret: string) => ({
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hookUrl, secret },
		cursor: null,
	});
	expect((await rpc(await modern(app.url, access, 1, "events/subscribe", params(secretA)))).body.result.id).toMatch(
		/^sub_[0-9a-f]{32}$/,
	);
	const deliveries = () => received.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"));
	const signedWith = (item: (typeof received)[number], ...secrets: string[]) =>
		item.headers["webhook-signature"] ===
		secrets.map((secret) => signatureOf(secret, item.headers, item.body)).join(" ");
	expect((await rpc(await modern(app.url, access, 2, "events/subscribe", params(secretB)))).body.result).toMatchObject({
		resultType: "complete",
	});
	await app.post("/api/messages", { topic: "plans", body: "After A→B for @preserve-bot" }, cookie);
	const afterRotation = await eventually(() => deliveries().find((item) => signedWith(item, secretB, secretA)));
	expect(afterRotation).toBeDefined();
	expect((await rpc(await modern(app.url, access, 3, "events/subscribe", params(secretB)))).body.result).toMatchObject({
		resultType: "complete",
	});
	await app.post("/api/messages", { topic: "plans", body: "After B→B for @preserve-bot" }, cookie);
	const afterRefresh = await eventually(() =>
		deliveries().find((item) => item.body.includes("After B→B") && signedWith(item, secretB, secretA)),
	);
	expect(afterRefresh).toBeDefined();
}, 40000);

it("rejects modern requests with array-valued client capabilities", async (test) => {
	const { app, cookie } = await installed(test);
	const { access } = await connect(app.url, cookie, "Modern client", "modern-bot");
	const response = await modern(app.url, access, 1, "tools/call", {
		name: "search_messages",
		arguments: { query: "test" },
	});
	expect(response.status).toBe(200);
	const malformed = await fetch(`${app.url}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${access}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2026-07-28",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "search_messages",
				arguments: { query: "test" },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": [],
				},
			},
		}),
	});
	expect(malformed.status).toBe(400);
	const body: unknown = await malformed.json();
	expect(Reflect.get(Object(body), "error")).toMatchObject({ code: -32602 });
}, 40000);

it("refuses callbacks that are not public HTTPS endpoints without connecting to them", async (test) => {
	const { app, cookie } = await installed(test);
	const { access } = await connect(app.url, cookie, "Event client", "gpt-bot");
	const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
	const listener = createNetServer((socket) => {
		connections.count++;
		socket.destroy();
	});
	const connections = { count: 0 };
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	test.onTestFinished(() => new Promise<void>((resolve) => listener.close(() => resolve())));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("listener has no address");
	const subscribe = async (url: string) =>
		(
			await (
				await modern(app.url, access, 1, "events/subscribe", {
					name: "mention.created",
					delivery: { mode: "webhook", url, secret },
				})
			).json()
		).error;
	expect(await subscribe(`http://127.0.0.1:${address.port}/hook`)).toMatchObject({ code: -32602 });
	expect(await subscribe("https://user:pw@example.com/hook")).toMatchObject({ code: -32602 });
	for (const url of [
		`https://127.0.0.1:${address.port}/hook`,
		`https://localhost:${address.port}/hook`,
		`https://[::ffff:127.0.0.1]:${address.port}/hook`,
		"https://169.254.169.254/latest",
	])
		expect(await subscribe(url), url).toMatchObject({ code: -32015, data: { reason: "connection_refused" } });
	expect(connections.count).toBe(0);
	// Each unverified callback spends the client's verification budget, capping how many hosts it can probe.
	for (let attempt = 4; attempt < 10; attempt++)
		expect(await subscribe(`https://127.0.0.${attempt}/hook`)).toMatchObject({ code: -32015 });
	expect(await subscribe("https://127.0.0.99/hook")).toMatchObject({
		code: -32013,
		data: { limit: "verifications", max: 10 },
	});
}, 30000);

it("treats only globally routable addresses as public", () => {
	for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
		expect(publicCallbackAddress(address), address).toBe(true);
	for (const address of [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"::ffff:127.0.0.1",
		"2001:db8::1",
		"2002::1",
		"64:ff9b::a00:1",
		"not-an-ip",
	])
		expect(publicCallbackAddress(address), address).toBe(false);
});

it("stops drain when subscription agent filter changes", async (test) => {
	const { app, cookie } = await installed(test, undefined, true);
	const { access, clientId } = await connect(app.url, cookie, "Filter client", "old-bot");
	const secret = `whsec_${Buffer.alloc(32, 14).toString("base64")}`;
	const received: Array<string> = [];
	const slowServer = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", async () => {
			await delay(400);
			const body = Buffer.concat(chunks).toString("utf8");
			received.push(body);
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	slowServer.listen(0, "127.0.0.1");
	await once(slowServer, "listening");
	test.onTestFinished(async () => {
		slowServer.closeAllConnections();
		await new Promise<void>((resolve) => slowServer.close(() => resolve()));
	});
	const address = slowServer.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const hookUrl = `http://127.0.0.1:${address.port}/hook`;
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });
	const params = (agent: string) => ({
		name: "mention.created",
		arguments: {},
		delivery: { mode: "webhook", url: hookUrl, secret },
		cursor: null,
	});
	expect((await rpc(await modern(app.url, access, 1, "events/subscribe", params("old-bot")))).body.result.id).toMatch(
		/^sub_[0-9a-f]{32}$/,
	);
	for (let n = 1; n <= 8; n++) {
		await app.post("/api/messages", { topic: "plans", body: `Old agent ${n} for @old-bot` }, cookie);
	}
	const deliveries = () => received.filter((body) => !body.includes("verification"));
	await eventually(() => deliveries().length > 0);
	const { access: newAccess } = await connect(app.url, cookie, "Filter client reauth", "new-bot");
	expect(
		(await rpc(await modern(app.url, newAccess, 2, "events/subscribe", params("new-bot")))).body.result,
	).toMatchObject({ resultType: "complete" });
	await delay(2000);
	const afterChange = deliveries().filter((body) => body.includes("@old-bot"));
	expect(afterChange.length).toBeLessThan(8);
}, 40000);

it("rejects malformed unsubscribe callback URLs", async (test) => {
	const { app, cookie } = await installed(test, undefined, true);
	const { access } = await connect(app.url, cookie, "Unsub client", "unsub-bot");
	const secret = `whsec_${Buffer.alloc(32, 15).toString("base64")}`;
	const receiver = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const parsed: unknown = JSON.parse(body);
			const challenge = Reflect.get(Object(parsed), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
		});
	});
	receiver.listen(0, "127.0.0.1");
	await once(receiver, "listening");
	test.onTestFinished(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
	const address = receiver.address();
	if (!address || typeof address === "string") throw new Error("receiver has no address");
	const validUrl = `http://127.0.0.1:${address.port}/hook`;
	const rpc = async (response: Response) => ({ status: response.status, body: await response.json() });
	const subscribed = await rpc(
		await modern(app.url, access, 1, "events/subscribe", {
			name: "mention.created",
			arguments: {},
			delivery: { mode: "webhook", url: validUrl, secret },
		}),
	);
	expect(subscribed.status).toBe(200);
	if (!("result" in subscribed.body)) {
		throw new Error(`Subscription failed: ${JSON.stringify(subscribed.body)}`);
	}
	expect(subscribed.body.result.id).toMatch(/^sub_[0-9a-f]{32}$/);
	const malformedUnsub = await rpc(
		await modern(app.url, access, 2, "events/unsubscribe", {
			name: "mention.created",
			arguments: {},
			delivery: { url: "not-a-url" },
		}),
	);
	expect(malformedUnsub.status).toBe(200);
	expect(malformedUnsub.body.error).toMatchObject({ code: -32602 });
	const filteredUnsub = await rpc(
		await modern(app.url, access, 3, "events/unsubscribe", {
			name: "mention.created",
			arguments: { topic: "plans" },
			delivery: { url: validUrl },
		}),
	);
	expect(filteredUnsub.status).toBe(200);
	expect(filteredUnsub.body.error).toMatchObject({ code: -32602 });
	const validUnsub = await rpc(
		await modern(app.url, access, 4, "events/unsubscribe", {
			name: "mention.created",
			arguments: {},
			delivery: { url: validUrl },
		}),
	);
	expect(validUnsub.status).toBe(200);
	expect(validUnsub.body.result).toMatchObject({ resultType: "complete" });
}, 40000);

it("rejects malformed modern envelope before legacy fallback", async (test) => {
	const { app } = await installed(test);
	const register = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Malformed client", redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = stringField(await register.json(), "client_id");
	const cookie = await app.login();
	const verifier = createHash("sha256").update("malformed-verifier").digest("base64url");
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource: "https://comms.test/mcp",
		scope: "read",
		state: "malformed-test",
	});
	const authorize = await fetch(`${app.url}/mcp/oauth/authorize?${query}`, { headers: { cookie } });
	expect(authorize.status).toBe(200);
	const approval = await fetch(`${app.url}/mcp/oauth/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			...Object.fromEntries(query),
			decision: "approve",
			agent: "malformed-test",
		}),
	});
	expect(approval.status).toBe(302);
	const callback = new URL(approval.headers.get("location") ?? "");
	const code = callback.searchParams.get("code");
	if (!code) throw new Error("authorization code is missing");
	const exchange = await fetch(`${app.url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			redirect_uri: "https://client.test/callback",
			resource: "https://comms.test/mcp",
			code,
			code_verifier: verifier,
		}),
	});
	expect(exchange.status).toBe(200);
	const tokens = await exchange.json();
	const access = stringField(tokens, "access_token");

	const call = (body: unknown) =>
		fetch(`${app.url}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${access}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});

	const malformedModernWithCapabilities = await call({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "search",
			arguments: { query: "test" },
			_meta: {
				"io.modelcontextprotocol/clientCapabilities": { capabilities: {} },
			},
		},
	});
	expect(malformedModernWithCapabilities.status).toBe(400);
	const result = await malformedModernWithCapabilities.json();
	expect(result).toMatchObject({
		jsonrpc: "2.0",
		id: 1,
		error: {
			code: -32602,
			message: "Invalid params: _meta needs io.modelcontextprotocol/protocolVersion and clientCapabilities",
		},
	});
	expect(result.error).not.toHaveProperty("data");

	const malformedModernWithNonObjectCapabilities = await call({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "search",
			arguments: { query: "test" },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": "not-an-object",
			},
		},
	});
	expect(malformedModernWithNonObjectCapabilities.status).toBe(400);
	const result2 = await malformedModernWithNonObjectCapabilities.json();
	expect(result2).toMatchObject({
		jsonrpc: "2.0",
		id: 2,
		error: {
			code: -32602,
			message: "Invalid params: _meta needs io.modelcontextprotocol/protocolVersion and clientCapabilities",
		},
	});

	const wellFormedModern = await call({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/list",
		params: {
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": { capabilities: {} },
			},
		},
	});
	expect(wellFormedModern.status).toBe(200);
	const result3 = await wellFormedModern.json();
	expect(result3).toMatchObject({
		jsonrpc: "2.0",
		id: 3,
		result: {
			resultType: "complete",
			tools: expect.any(Array),
		},
	});
}, 30000);
