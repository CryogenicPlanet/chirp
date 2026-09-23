import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

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

const installed = async (test: TestContext, mcpOrigin?: string) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await cp(join(import.meta.dirname, "../../../examples/extensions/mcp"), join(seed, "ext/mcp"), { recursive: true });
	for (const file of ["index.ts", "oauth.ts", "tools.ts"]) {
		const path = join(seed, `ext/mcp/${file}`);
		const source = (await readFile(path, "utf8"))
			.replace("../../../packages/server/src/kernel/extension-api.ts", "../../kernel/extension-api.ts")
			.replace("https://your-board.example", "https://comms.test");
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
		body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve" }),
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
		expect(await consent.text()).toContain(`Authorize ${clientName}`);
		const approvalBody = { ...Object.fromEntries(query), decision: "approve" };
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
		await call(reader.access, 3, "tools/call", { name: "search", arguments: { query: "quarterly launch" } })
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
	const denied = await (
		await call(reader.access, 5, "tools/call", {
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
	const first = await (await call(writer.access, 6, "tools/call", post)).json();
	const replay = await (await call(writer.access, 7, "tools/call", post)).json();
	expect(first.result.structuredContent).toMatchObject({
		topic: "plans",
		body: "Approved via MCP",
		agent: "system",
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
	const otherWriter = await grant("read write", "other-writer", otherClientId, "Other client");
	const separate = await (await call(otherWriter.access, 8, "tools/call", post)).json();
	expect(separate.result.structuredContent.id).not.toBe(first.result.structuredContent.id);

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
