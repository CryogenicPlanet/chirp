import { authorLabel } from "@comms/protocol";
import { assertionHeader } from "@comms/protocol/headers";
import { createHash } from "node:crypto";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

type App = Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) => Schema.decodeUnknownSync(schema)(value);
const json = (text: string) => Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text);
const ToolReply = Schema.Struct({
	result: Schema.Struct({
		content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
		structuredContent: Schema.optionalKey(Schema.Unknown),
		isError: Schema.optionalKey(Schema.Boolean),
	}),
});
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A board with the MCP package installed as an operator would, optionally with the reply-thread example. */
const installed = async (test: TestContext, thread: boolean) => {
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
				.replace("https://your-board.example", "https://comms.test"),
		);
	}
	if (thread)
		await writeFile(
			join(seed, "ext/thread.ts"),
			(await readFile(join(import.meta.dirname, "../../../examples/extensions/thread.ts"), "utf8")).replace(
				"../../packages/server/src/kernel/extension-api.ts",
				"../kernel/extension-api.ts",
			),
		);
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	return { fixture, app, cookie };
};

/** Registers a client and returns what its authorization request carries. */
const register = async (app: App, name: string) => {
	const registration = await fetch(`${app.url}/mcp/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: name, redirect_uris: ["https://client.test/callback"] }),
	});
	const clientId = decode(Schema.Struct({ client_id: Schema.String }), await registration.json()).client_id;
	const verifier = createHash("sha256").update(`verifier-${name}`).digest("base64url");
	const query = {
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.test/callback",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource: "https://comms.test/mcp",
		scope: "read write",
		state: `state-${name}`,
	};
	return { clientId, verifier, query };
};
const form = (app: App, cookie: string, path: string, body: Readonly<Record<string, string>>) =>
	fetch(`${app.url}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
/** The client's half: the code from its callback, exchanged for an access token. */
const exchange = async (app: App, client: Awaited<ReturnType<typeof register>>, location: string | null) => {
	const callback = new URL(location ?? "");
	expect(callback.origin + callback.pathname).toBe("https://client.test/callback");
	expect(callback.searchParams.get("state")).toBe(client.query.state);
	const token = await fetch(`${app.url}/mcp/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: client.clientId,
			redirect_uri: "https://client.test/callback",
			resource: "https://comms.test/mcp",
			code: callback.searchParams.get("code") ?? "",
			code_verifier: client.verifier,
		}),
	});
	expect(token.status).toBe(200);
	return decode(Schema.Struct({ access_token: Schema.String }), await token.json()).access_token;
};
/** The human's decision on boot's approval page, signed with the test passkey. */
const decide = async (app: App, approveUrl: string, decision: "approve" | "deny", scopes: readonly string[]) => {
	const id = new URL(approveUrl).pathname.split("/").at(-1) ?? "";
	const decided = await fetch(`${app.url}/_boot/enroll/${id}/approve`, {
		method: "POST",
		headers: {
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: await app.assertion({ id, decision, scopes, long_lived: false }),
		},
		body: JSON.stringify({ decision, scopes, long_lived: false }),
	});
	expect(decided.status, await decided.clone().text()).toBe(200);
};
/** The consent step's page: it shows the request code, then links to boot's approval page. */
const editingStep = async (app: App, response: Response) => {
	expect(response.status).toBe(200);
	const html = await response.text();
	const code = /request code is <code>([0-9A-F]{6})<\/code>/.exec(html)?.[1] ?? "";
	expect(code).toMatch(/^[0-9A-F]{6}$/);
	const approval = new URL(/href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "");
	expect(approval.origin + approval.pathname).toMatch(/^https:\/\/comms\.test\/approve\/e_[A-Za-z0-9_-]{43}$/);
	// Boot's page shows the same code, which is how the human knows the request came from this consent.
	expect(await (await fetch(`${app.url}${approval.pathname}`)).text()).toContain(code);
	const back = approval.searchParams.get("return") ?? "";
	expect(back).toMatch(/^\/mcp\/oauth\/continue\?consent=mcp_consent_/);
	return { code, approval, back, consent: new URL(back, app.url).searchParams.get("consent") ?? "" };
};
/** The live grant families mcp holds, as the board's token list shows them. */
const held = async (app: App, cookie: string) =>
	decode(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					family: Schema.String,
					agent: Schema.String,
					label: Schema.String,
					held_by: Schema.NullOr(Schema.String),
					revoked: Schema.Boolean,
				}),
			),
		}),
		await (await fetch(`${app.url}/_boot/tokens`, { headers: { cookie } })).json(),
	).items.filter((item) => item.held_by === "mcp" && !item.revoked);
/** Revokes an agent's live grant family from the board's token list, as the human would. */
const revoke = async (app: App, cookie: string, agent: string, label?: string) => {
	const families = (await held(app, cookie)).filter(
		(item) => item.agent === agent && (label === undefined || item.label === label),
	);
	expect(families).toHaveLength(1);
	const family = families[0]?.family ?? "";
	const revoked = await fetch(`${app.url}/_boot/tokens/${family}/revoke`, {
		method: "POST",
		headers: {
			cookie,
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: await app.revocationAssertion(family, cookie),
		},
		body: "{}",
	});
	expect(revoked.status).toBe(200);
};
/** An MCP client on the initialize handshake; each call is its own stateless request, from `userAgent` when given. */
const mcp = (app: App, token: string, userAgent?: string) => {
	let id = 0;
	const send = (method: string, params?: unknown) =>
		fetch(`${app.url}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": "2025-11-25",
				...(userAgent === undefined ? {} : { "user-agent": userAgent }),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params === undefined ? {} : { params }) }),
		});
	const tool = async (name: string, args: Readonly<Record<string, unknown>> = {}) => {
		const response = await send("tools/call", { name, arguments: args });
		const text = await response.text();
		const { result } = decode(ToolReply, json(text));
		return result.isError
			? { ok: undefined, error: json(result.content[0]?.text ?? ""), structured: result.structuredContent }
			: { ok: result.structuredContent, error: undefined, structured: result.structuredContent };
	};
	return { send, tool };
};

it("connects with editing approved by passkey, then edits, publishes and live-edits as the posting agent", async (test) => {
	const { fixture, app, cookie } = await installed(test, true);
	const client = await register(app, "Dot Client");
	const consentPage = await (
		await fetch(`${app.url}/mcp/oauth/authorize?${new URLSearchParams(client.query)}`, { headers: { cookie } })
	).text();
	expect(consentPage).toContain('name="editing" value="1" checked');
	expect(consentPage).toContain("unticked by default");

	// Consent with editing shows the request code, then boot's approval page comes back to the continue route.
	const { code, approval, back, consent } = await editingStep(
		app,
		await form(app, cookie, "/mcp/oauth/authorize", {
			...client.query,
			decision: "approve",
			agent: "dot",
			editing: "1",
		}),
	);
	expect(await (await fetch(`${app.url}${back}`, { headers: { cookie } })).text()).toContain("still waiting");
	await decide(app, approval.href, "approve", ["read", "write", "fs"]);
	const returned = await (await fetch(`${app.url}${back}`, { headers: { cookie } })).text();
	expect(returned).toContain("Editing approved");
	expect(returned).toContain("<strong>dot</strong>");
	expect(returned).toContain(code);
	const finished = await form(app, cookie, "/mcp/oauth/continue", { consent });
	expect(finished.status).toBe(302);
	const access = await exchange(app, client, finished.headers.get("location"));
	expect((await form(app, cookie, "/mcp/oauth/continue", { consent })).status).toBe(400);
	const { tool } = mcp(app, access);

	const info = (await tool("connection_info")).ok;
	expect(info).toMatchObject({
		posting_name: "dot",
		editing: { status: "active", agent: "dot", scopes: ["read", "write", "fs"] },
	});
	// connection_info describes the grant without its family id (which still shows as the instance of its posts).
	expect(JSON.stringify(info)).not.toMatch(/"f_[A-Za-z0-9_-]{43}"/);

	// Posts through the grant are the agent's own, so it can edit and delete them.
	const Posted = Schema.Struct({ seq: Schema.Int, instance: Schema.String });
	const posted = decode(
		Posted,
		(await tool("post_message", { topic: "dot", body: "first draft", idempotencyKey: "dot-1" })).ok,
	);
	expect((await tool("post_message", { topic: "dot", body: "first draft", idempotencyKey: "dot-1" })).ok).toMatchObject(
		{ seq: posted.seq },
	);
	expect(posted.instance).toMatch(/^f_/);
	const listed = decode(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ seq: Schema.Int, agent: Schema.String, instance: Schema.String })),
		}),
		await (await fetch(`${app.url}/api/messages?topic=dot&since=0`, { headers: { cookie } })).json(),
	).items;
	expect(listed.find((item) => item.seq === posted.seq)).toMatchObject({ agent: "dot", instance: posted.instance });
	expect((await tool("edit_message", { seq: posted.seq, body: "final text" })).ok).toMatchObject({
		seq: posted.seq,
		agent: "dot",
		body: "final text",
		edited_at: expect.any(Number),
	});
	const reply = decode(
		Posted,
		(
			await tool("post_message", {
				topic: "dot/replies",
				body: "a reply",
				meta: { reply_to: posted.seq },
				idempotencyKey: "dot-2",
			})
		).ok,
	);
	expect((await tool("read_thread", { seq: reply.seq })).ok).toMatchObject({
		root: posted.seq,
		items: [{ seq: posted.seq }, { seq: reply.seq, parent: posted.seq }],
	});
	expect((await tool("delete_message", { seq: reply.seq })).ok).toMatchObject({ deleted_at: expect.any(Number) });

	// Pages publish as the agent, and replacing one needs its current version.
	const notes = "# Notes from dot\n";
	expect((await tool("write_page", { path: "dot/notes.md", content: notes })).ok).toEqual({
		path: "dot/notes.md",
		url: "https://comms.test/p/dot/notes.md",
		version: sha256(notes),
		batch: expect.any(String),
	});
	expect((await tool("read_page", { path: "dot/notes.md" })).ok).toMatchObject({ text: notes });
	// read_page has no version, so the refusal names the one to pass.
	expect((await tool("write_page", { path: "dot/notes.md", content: "# Clobbered\n" })).error).toMatchObject({
		error: { code: "stale_base", retriable: false, hint: expect.stringContaining(`"${sha256(notes)}"`) },
	});
	expect(
		(await tool("write_page", { path: "dot/notes.md", content: "# Notes v2\n", base_version: sha256(notes) })).ok,
	).toMatchObject({ version: sha256("# Notes v2\n") });
	const history = decode(
		Schema.Struct({ items: Schema.Array(Schema.Struct({ agent: Schema.String })) }),
		await (await fetch(`${app.url}/api/fs/pages/dot/notes.md?history`, { headers: { cookie } })).json(),
	);
	expect(history.items[0]?.agent).toBe("dot");
	const scratch = decode(
		Schema.Struct({ version: Schema.String }),
		(await tool("write_page", { path: "dot/scratch.md", content: "scratch" })).ok,
	).version;
	expect((await tool("delete_page", { path: "dot/scratch.md", base_version: scratch })).ok).toEqual({
		path: "dot/scratch.md",
		deleted: true,
	});
	expect((await tool("read_page", { path: "dot/scratch.md" })).error).toMatchObject({
		error: { code: "page_not_found" },
	});

	// Topics.
	expect((await tool("set_topic_meta", { path: "dot", meta: { description: "Dot's desk" } })).ok).toMatchObject({
		path: "dot",
		meta: { description: "Dot's desk" },
	});
	expect((await tool("read_topic", { path: "dot", include_messages: false })).ok).toMatchObject({
		meta: { description: "Dot's desk" },
	});
	expect((await tool("move_topic", { path: "dot", to: "dot-desk", idempotency_key: "move-1" })).ok).toMatchObject({
		from: "dot",
		to: "dot-desk",
	});

	// Live edit: lock, read, stage, reload. The reload returns at once and is observed from later calls.
	expect((await tool("acquire_lock", { note: "mcp live edit" })).ok).toMatchObject({
		lock: { agent: "dot", mine: true, note: "mcp live edit", reload_in_flight: false },
	});
	const source = decode(
		Schema.Struct({ version: Schema.String, content: Schema.String, truncated: Schema.Boolean }),
		(await tool("read_source", { path: "server.ts" })).ok,
	);
	expect(source.truncated).toBe(false);
	const edited = `${source.content}\n// staged by dot through MCP\n`;
	expect((await tool("stage_source", { path: "server.ts", content: edited, base_version: source.version })).ok).toEqual(
		{ path: "server.ts", staged: true, version: sha256(edited) },
	);
	expect((await tool("read_source", { path: "server.ts" })).ok).toMatchObject({
		content: edited,
		version: sha256(edited),
	});
	expect(
		(await tool("stage_source", { path: "server.ts", content: edited, base_version: source.version })).error,
	).toMatchObject({
		error: { code: "stale_base" },
	});
	const before = decode(
		Schema.Struct({ live_generation: Schema.Int }),
		(await tool("reload_status")).ok,
	).live_generation;
	const started = performance.now();
	expect((await tool("reload")).ok).toMatchObject({
		status: "reloading",
		message: expect.stringContaining("reload_status"),
	});
	expect(performance.now() - started).toBeLessThan(5000);
	// Rehearsals number generations too, so the new one is any later number.
	const Status = Schema.Struct({
		live_generation: Schema.Int,
		latest: Schema.Struct({ n: Schema.Int, status: Schema.String, error: Schema.NullOr(Schema.String) }),
		lock: Schema.Struct({ mine: Schema.Boolean, reload_in_flight: Schema.Boolean }),
	});
	await expect
		.poll(
			async () => {
				try {
					const status = decode(Status, (await tool("reload_status")).ok);
					return { ...status, newer: status.live_generation > before && status.latest.n === status.live_generation };
				} catch {
					return undefined;
				}
			},
			{ timeout: 60000, interval: 500 },
		)
		.toMatchObject({
			newer: true,
			latest: { status: "live", error: null },
			lock: { mine: true, reload_in_flight: false },
		});
	expect(await (await fetch(`${app.url}/api/fs/app/server.ts`, { headers: { cookie } })).text()).toContain(
		"// staged by dot through MCP",
	);
	expect((await tool("release_lock")).ok).toEqual({ released: true });
	expect((await tool("reload_status")).ok).toMatchObject({ lock: null });

	// A grant belongs to the human who approved it: under another subject the row is not this connection's grant.
	await fixture.sql(`UPDATE example_mcp_grants SET subject='another-human' WHERE client_id='${client.clientId}'`);
	expect((await tool("connection_info")).ok).toMatchObject({ editing: { status: "none" } });
	expect((await tool("edit_message", { seq: posted.seq, body: "as someone else" })).error).toMatchObject({
		error: { code: "editing_not_granted" },
	});
	await fixture.sql(`UPDATE example_mcp_grants SET subject='rahul' WHERE client_id='${client.clientId}'`);
	expect((await tool("connection_info")).ok).toMatchObject({ editing: { status: "active", agent: "dot" } });

	// Revoking the family on the board's token list ends editing; posting falls back to the extension's own voice.
	await revoke(app, cookie, "dot");
	expect((await tool("edit_message", { seq: posted.seq, body: "after revocation" })).error).toMatchObject({
		error: {
			code: "editing_not_granted",
			message: expect.stringContaining("revoked"),
			hint: expect.stringContaining("request_editing"),
		},
	});
	expect((await tool("connection_info")).ok).toMatchObject({ editing: { status: "revoked" } });
	expect(
		(await tool("post_message", { topic: "dot-desk", body: "still here", idempotencyKey: "dot-3" })).ok,
	).toMatchObject({ agent: "dot", instance: `extension:mcp:${client.clientId}` });
}, 240000);

it("lets an existing connection request editing, keeps fs opt-in, and never blocks a connection on denial", async (test) => {
	const { app, cookie } = await installed(test, false);
	// Connected the way dot already is: consent without the editing step.
	const client = await register(app, "Existing Client");
	const connected = await form(app, cookie, "/mcp/oauth/authorize", {
		...client.query,
		decision: "approve",
		agent: "existing-bot",
	});
	expect(connected.status).toBe(302);
	const { send, tool } = mcp(app, await exchange(app, client, connected.headers.get("location")));

	// Every tool states all three hints, a title and an output schema; sends and edits are destructive.
	const listed = decode(
		Schema.Struct({
			result: Schema.Struct({
				tools: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						title: Schema.String,
						outputSchema: Schema.Struct({ type: Schema.Literal("object") }),
						annotations: Schema.Struct({
							readOnlyHint: Schema.Boolean,
							destructiveHint: Schema.Boolean,
							openWorldHint: Schema.Boolean,
						}),
					}),
				),
			}),
		}),
		await (await send("tools/list")).json(),
	).result.tools;
	const hints = Object.fromEntries(listed.map((item) => [item.name, item.annotations]));
	for (const name of [
		"connection_info",
		"search",
		"fetch",
		"query_messages",
		"read_topic",
		"read_page",
		"read_thread",
		"read_source",
		"reload_status",
	])
		expect(hints[name], name).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
	for (const name of [
		"post_message",
		"edit_message",
		"delete_message",
		"set_topic_meta",
		"move_topic",
		"write_page",
		"delete_page",
		"stage_source",
		"delete_source",
		"reload",
		"release_lock",
	])
		expect(hints[name], name).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
	expect(listed).toHaveLength(22);

	expect((await tool("connection_info")).ok).toMatchObject({
		posting_name: "existing-bot",
		editing: { status: "none", scopes: [], expires_at: null },
	});
	const earlier = decode(
		Schema.Struct({ seq: Schema.Int }),
		(await tool("post_message", { topic: "existing", body: "posted before editing", idempotencyKey: "e-1" })).ok,
	).seq;
	expect((await tool("edit_message", { seq: earlier, body: "changed" })).error).toMatchObject({
		error: { code: "editing_not_granted", hint: expect.stringContaining("request_editing") },
	});

	// request_editing hands the user a link and code; asking again reports the same waiting request.
	const Requested = Schema.Struct({
		status: Schema.Literal("pending"),
		approve_url: Schema.String,
		code: Schema.String,
		expires_at: Schema.Int,
	});
	// Concurrent requests for one connection all get the single request the extension tracks.
	const replies = (await Promise.all([tool("request_editing"), tool("request_editing"), tool("request_editing")])).map(
		(reply) => decode(Requested, reply.ok),
	);
	const requested = replies[0];
	if (!requested) throw new Error("request_editing returned nothing");
	for (const reply of replies) expect(reply).toEqual(requested);
	expect(requested.approve_url).toMatch(/^https:\/\/comms\.test\/approve\/e_/);
	// The user matches this code against the one boot's approval page shows.
	expect(requested.code).toMatch(/^[0-9A-F]{6}$/);
	expect(await (await fetch(`${app.url}${new URL(requested.approve_url).pathname}`)).text()).toContain(requested.code);
	expect((await tool("request_editing")).ok).toMatchObject({ status: "pending", approve_url: requested.approve_url });
	expect((await tool("edit_message", { seq: earlier, body: "changed" })).error).toMatchObject({
		error: { code: "editing_not_granted", message: expect.stringContaining(requested.approve_url) },
	});
	// The human leaves fs unticked.
	await decide(app, requested.approve_url, "approve", ["read", "write"]);
	expect((await tool("connection_info")).ok).toMatchObject({
		editing: { status: "active", agent: "existing-bot", scopes: ["read", "write"], expires_at: expect.any(Number) },
	});
	expect((await tool("request_editing")).ok).toMatchObject({ status: "active" });

	// The board's own refusal comes back unchanged: the earlier post belongs to the extension's instance.
	expect((await tool("edit_message", { seq: earlier, body: "changed" })).error).toMatchObject({
		error: { code: "author_required", retriable: false },
	});
	const own = decode(
		Schema.Struct({ seq: Schema.Int }),
		(await tool("post_message", { topic: "existing", body: "posted with editing", idempotencyKey: "e-2" })).ok,
	).seq;
	expect((await tool("edit_message", { seq: own, tags: ["edited"] })).ok).toMatchObject({ tags: ["edited"] });

	// Without fs, pages and source are refused before reaching the board.
	for (const [name, args] of [
		["write_page", { path: "existing/plan.md", content: "# Plan\n" }],
		["stage_source", { path: "server.ts", content: "", base_version: null }],
		["acquire_lock", {}],
	] as const)
		expect((await tool(name, args)).error, name).toMatchObject({
			error: { code: "scope_required", hint: expect.stringContaining("tick fs") },
		});
	// Threads need the board's thread extension, which this board lacks.
	expect((await tool("read_thread", { seq: own })).error).toMatchObject({ error: { code: "not_available" } });

	// Re-authorizing the same client under another posting name never acts through the earlier grant.
	const renamed = await form(app, cookie, "/mcp/oauth/authorize", {
		...client.query,
		decision: "approve",
		agent: "renamed-bot",
	});
	expect(renamed.status).toBe(302);
	const renamedTool = mcp(app, await exchange(app, client, renamed.headers.get("location"))).tool;
	expect((await renamedTool("connection_info")).ok).toMatchObject({
		posting_name: "renamed-bot",
		editing: { status: "none" },
	});
	expect((await renamedTool("edit_message", { seq: own, body: "taken over" })).error).toMatchObject({
		error: { code: "editing_not_granted" },
	});
	expect(
		(await renamedTool("post_message", { topic: "existing", body: "renamed", idempotencyKey: "r-1" })).ok,
	).toMatchObject({ agent: "renamed-bot", instance: `extension:mcp:${client.clientId}` });
	const renamedRequest = decode(Requested, (await renamedTool("request_editing")).ok);
	expect(renamedRequest.approve_url).not.toBe(requested.approve_url);
	// One grant per connection: the new identity's request replaces the earlier one, which no token uses any more.
	expect((await tool("connection_info")).ok).toMatchObject({ editing: { status: "none" } });

	// A denied editing approval still finishes connecting: the client reads and posts as before.
	const denied = await register(app, "Denied Client");
	const step = await editingStep(
		app,
		await form(app, cookie, "/mcp/oauth/authorize", {
			...denied.query,
			decision: "approve",
			agent: "denied-bot",
			editing: "1",
		}),
	);
	await decide(app, step.approval.href, "deny", []);
	expect(await (await fetch(`${app.url}${step.back}`, { headers: { cookie } })).text()).toContain("not approved");
	const finished = await form(app, cookie, "/mcp/oauth/continue", { consent: step.consent });
	const deniedTool = mcp(app, await exchange(app, denied, finished.headers.get("location"))).tool;
	expect((await deniedTool("connection_info")).ok).toMatchObject({ editing: { status: "denied" } });
	expect(
		(await deniedTool("post_message", { topic: "existing", body: "no editing", idempotencyKey: "d-1" })).ok,
	).toMatchObject({ agent: "denied-bot", instance: `extension:mcp:${denied.clientId}` });

	// A grant the human narrowed to read leaves posting as it was.
	const narrowed = decode(Requested, (await deniedTool("request_editing")).ok);
	await decide(app, narrowed.approve_url, "approve", ["read"]);
	expect((await deniedTool("connection_info")).ok).toMatchObject({ editing: { status: "active", scopes: ["read"] } });
	expect(
		(await deniedTool("post_message", { topic: "existing", body: "read-only grant", idempotencyKey: "d-2" })).ok,
	).toMatchObject({ agent: "denied-bot", instance: `extension:mcp:${denied.clientId}` });
	// After a revocation, request_editing asks boot afresh instead of reporting the old grant.
	await revoke(app, cookie, "denied-bot");
	const again = decode(Requested, (await deniedTool("request_editing")).ok);
	expect(again.approve_url).not.toBe(narrowed.approve_url);
	// Approval itself creates the family, so a grant revoked before the extension ever collects it reads as revoked.
	await decide(app, again.approve_url, "approve", ["read", "write"]);
	await revoke(app, cookie, "denied-bot");
	expect((await deniedTool("connection_info")).ok).toMatchObject({ editing: { status: "revoked" } });
	expect((await deniedTool("edit_message", { seq: own, body: "x" })).error).toMatchObject({
		error: { code: "editing_not_granted", message: expect.stringContaining("revoked") },
	});
}, 120000);

const chatgpt = "openai-mcp/1.0.0";
const codex = "openai-mcp/1.0.0 (Codex)";
const unrecognised = "custom-agent/2.1";

it("labels each client sharing a connection by its User-Agent and gives each its own grant", async (test) => {
	const { app, cookie } = await installed(test, false);
	// One connector serves several clients, as ChatGPT's serves ChatGPT and Codex: one OAuth client and token.
	const client = await register(app, "Desk Client");
	const step = await editingStep(
		app,
		await form(app, cookie, "/mcp/oauth/authorize", {
			...client.query,
			decision: "approve",
			agent: "dot",
			editing: "1",
		}),
	);
	await decide(app, step.approval.href, "approve", ["read", "write"]);
	const access = await exchange(
		app,
		client,
		(await form(app, cookie, "/mcp/oauth/continue", { consent: step.consent })).headers.get("location"),
	);
	const as = (userAgent?: string) => mcp(app, access, userAgent).tool;

	// The label comes from the User-Agent; a client this server does not recognise is named after its registration.
	for (const [userAgent, label] of [
		[chatgpt, "chatgpt"],
		[codex, "codex"],
		["Claude-User/1.0", "claude"],
		[unrecognised, "desk-client"],
	] as const)
		expect((await as(userAgent)("connection_info")).ok, userAgent).toMatchObject({ posting_name: "dot", label });

	// Consent sees only the browser, so it approved the surface named after the client; Codex asks for its own.
	expect((await as(unrecognised)("connection_info")).ok).toMatchObject({ editing: { status: "active", agent: "dot" } });
	expect((await as(codex)("connection_info")).ok).toMatchObject({ editing: { status: "none" } });
	const requested = decode(
		Schema.Struct({ status: Schema.Literal("pending"), approve_url: Schema.String, message: Schema.String }),
		(await as(codex)("request_editing")).ok,
	);
	// The user is told the label is the client's claim, not a boundary between the clients of a connection.
	expect(requested.message).toContain(
		"labelled codex. The label is reported by the client; any client of this connection can use this grant.",
	);
	await decide(app, requested.approve_url, "approve", ["read", "write"]);
	expect((await as(codex)("connection_info")).ok).toMatchObject({ editing: { status: "active", agent: "dot" } });
	expect((await as(chatgpt)("connection_info")).ok).toMatchObject({ editing: { status: "none" } });
	// Boot labels each grant with its surface, so the token list and every call through it read as name@label.
	const families = await held(app, cookie);
	expect(families.map((item) => `${item.agent}@${item.label}`).sort()).toEqual(["dot@codex", "dot@desk-client"]);
	const codexFamily = families.find((item) => item.label === "codex")?.family;
	const deskFamily = families.find((item) => item.label === "desk-client")?.family;

	// Each surface posts through its own grant, or the extension's instance without one, and records its label.
	const Posted = Schema.Struct({ seq: Schema.Int, instance: Schema.String });
	const posts = [
		decode(
			Posted,
			(
				await as(codex)("post_message", {
					topic: "desk",
					body: "from codex",
					meta: { author_label: "chatgpt" },
					idempotencyKey: "codex-1",
				})
			).ok,
		),
		decode(Posted, (await as(unrecognised)("post_message", { topic: "desk", body: "desk", idempotencyKey: "d-1" })).ok),
		decode(Posted, (await as(chatgpt)("post_message", { topic: "desk", body: "chat", idempotencyKey: "g-1" })).ok),
	];
	expect(posts.map((posted) => posted.instance)).toEqual([codexFamily, deskFamily, `extension:mcp:${client.clientId}`]);
	const human = decode(
		Posted,
		await (await app.post("/api/messages", { topic: "desk", body: "by hand" }, cookie)).json(),
	);
	// The feed reads the board's message API and shows each author as name@label, or the name alone without one.
	const listed = decode(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ seq: Schema.Int, agent: Schema.String, meta: Schema.JsonObject })),
		}),
		await (await fetch(`${app.url}/api/messages?topic=desk&since=0`, { headers: { cookie } })).json(),
	).items;
	const shown = (seq: number) =>
		listed
			.filter((item) => item.seq === seq)
			.map((item) => [item.agent, authorLabel(item.meta)].filter((part) => part !== undefined).join("@"))[0];
	expect([...posts, human].map((posted) => shown(posted.seq))).toEqual([
		"dot@codex",
		"dot@desk-client",
		"dot@chatgpt",
		"rahul",
	]);

	// Only the grant that posted can edit, and the label stays whatever meta the client sends.
	const fromCodex = posts[0]?.seq ?? 0;
	expect(
		(await as(codex)("edit_message", { seq: fromCodex, meta: { author_label: "chatgpt", note: 1 } })).ok,
	).toMatchObject({ meta: { author_label: "codex", note: 1 } });
	expect((await as(unrecognised)("edit_message", { seq: fromCodex, body: "taken over" })).error).toMatchObject({
		error: { code: "author_required" },
	});

	// Each surface's grant is revoked on its own.
	await revoke(app, cookie, "dot", "codex");
	expect((await as(codex)("connection_info")).ok).toMatchObject({ editing: { status: "revoked" } });
	expect((await as(unrecognised)("connection_info")).ok).toMatchObject({ editing: { status: "active" } });
}, 120000);

it("namespaces fallback post idempotency keys by client label", async (test) => {
	const { app, cookie } = await installed(test, false);
	const client = await register(app, "Shared Client");
	const connected = await form(app, cookie, "/mcp/oauth/authorize", {
		...client.query,
		decision: "approve",
		agent: "shared-bot",
	});
	expect(connected.status).toBe(302);
	const access = await exchange(app, client, connected.headers.get("location"));
	const as = (userAgent: string) => mcp(app, access, userAgent).tool;
	expect((await as(chatgpt)("connection_info")).ok).toMatchObject({
		label: "chatgpt",
		editing: { status: "none" },
	});
	expect((await as(codex)("connection_info")).ok).toMatchObject({ label: "codex", editing: { status: "none" } });
	const Posted = Schema.Struct({
		seq: Schema.Int,
		instance: Schema.String,
		meta: Schema.Struct({ author_label: Schema.String }),
	});
	const chat = decode(
		Posted,
		(await as(chatgpt)("post_message", { topic: "shared", body: "from chatgpt", idempotencyKey: "same-key" })).ok,
	);
	const code = decode(
		Posted,
		(await as(codex)("post_message", { topic: "shared", body: "from codex", idempotencyKey: "same-key" })).ok,
	);
	expect(chat.instance).toBe(`extension:mcp:${client.clientId}`);
	expect(code.instance).toBe(chat.instance);
	expect(code.seq).not.toBe(chat.seq);
	expect(chat.meta.author_label).toBe("chatgpt");
	expect(code.meta.author_label).toBe("codex");
	expect(
		(await as(chatgpt)("post_message", { topic: "shared", body: "from chatgpt", idempotencyKey: "same-key" })).ok,
	).toMatchObject({ seq: chat.seq });
	expect(
		(await as(chatgpt)("post_message", { topic: "shared", body: "different body", idempotencyKey: "same-key" })).error,
	).toMatchObject({ error: { code: "idempotency_conflict" } });
	expect(
		(await as(chatgpt)("post_message", { topic: "shared", body: "max key", idempotencyKey: "k".repeat(156) })).ok,
	).toMatchObject({ instance: `extension:mcp:${client.clientId}` });
	expect(
		(await as(chatgpt)("post_message", { topic: "shared", body: "too long", idempotencyKey: "k".repeat(157) })).error,
	).toMatchObject({ error: { code: "input_invalid" } });
}, 120000);

it("moves a grant recorded per connection to the surface named after its client, still approved", async (test) => {
	const { fixture, app, cookie } = await installed(test, false);
	const client = await register(app, "Legacy Client");
	const step = await editingStep(
		app,
		await form(app, cookie, "/mcp/oauth/authorize", {
			...client.query,
			decision: "approve",
			agent: "legacy-bot",
			editing: "1",
		}),
	);
	await decide(app, step.approval.href, "approve", ["read", "write"]);
	const access = await exchange(
		app,
		client,
		(await form(app, cookie, "/mcp/oauth/continue", { consent: step.consent })).headers.get("location"),
	);
	const family = (await held(app, cookie)).find((item) => item.agent === "legacy-bot")?.family;
	expect(family).toMatch(/^f_/);
	await app.stop();
	// Put the table back as a board from before surfaces has it: keyed by client_id, the surface steps not yet run.
	for (const statement of [
		"ALTER TABLE example_mcp_grants RENAME TO surface_grants_copy",
		"CREATE TABLE example_mcp_grants(client_id TEXT PRIMARY KEY,subject TEXT NOT NULL,request_id TEXT NOT NULL,approve_url TEXT NOT NULL,code TEXT,agent TEXT NOT NULL,family TEXT,scopes TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,families TEXT)",
		"INSERT INTO example_mcp_grants SELECT client_id,subject,request_id,approve_url,code,agent,family,scopes,status,expires_at,created_at,updated_at,families FROM surface_grants_copy",
		"DROP TABLE surface_grants_copy",
		"UPDATE protected_sql_tables SET migration='agent_grants' WHERE name='example_mcp_grants'",
		"DELETE FROM extension_migrations WHERE extension='mcp' AND name LIKE 'grant_surfaces%'",
	])
		await fixture.sql(statement);

	const restarted = await fixture.launch(join(fixture.root, "seed", "server.ts"));
	await restarted.ready(await restarted.login());
	expect(await fixture.sql("SELECT client_id,surface,agent,family,status FROM example_mcp_grants")).toEqual([
		{ client_id: client.clientId, surface: "legacy-client", agent: "legacy-bot", family, status: "active" },
	]);
	expect(
		await fixture.sql("SELECT name,extension FROM protected_sql_tables WHERE name LIKE 'example_mcp%' ORDER BY name"),
	).toEqual([
		{ name: "example_mcp_events", extension: "mcp" },
		{ name: "example_mcp_grants", extension: "mcp" },
		{ name: "example_mcp_oauth", extension: "mcp" },
	]);
	// The client goes on editing through the grant it had, without another approval; Codex would ask for its own.
	const { tool } = mcp(restarted, access);
	expect((await tool("connection_info")).ok).toMatchObject({
		label: "legacy-client",
		editing: { status: "active", agent: "legacy-bot" },
	});
	expect(
		(await tool("post_message", { topic: "legacy", body: "after the move", idempotencyKey: "l-1" })).ok,
	).toMatchObject({ instance: family, meta: { author_label: "legacy-client" } });
	expect((await mcp(restarted, access, codex).tool("connection_info")).ok).toMatchObject({
		label: "codex",
		editing: { status: "none" },
	});
}, 120000);

it("approves at consent the label a Claude-named client's calls carry", async (test) => {
	const { app, cookie } = await installed(test, false);
	const client = await register(app, "Claude Desktop");
	const step = await editingStep(
		app,
		await form(app, cookie, "/mcp/oauth/authorize", {
			...client.query,
			decision: "approve",
			agent: "desk-bot",
			editing: "1",
		}),
	);
	await decide(app, step.approval.href, "approve", ["read", "write"]);
	const access = await exchange(
		app,
		client,
		(await form(app, cookie, "/mcp/oauth/continue", { consent: step.consent })).headers.get("location"),
	);
	// Its calls say Claude-User, so they carry claude, and find the grant approved at consent.
	const info = (await mcp(app, access, "Claude-User/1.0").tool("connection_info")).ok;
	expect(info).toMatchObject({
		label: "claude",
		label_note: expect.stringContaining("any client of this connection can use this grant"),
		editing: { status: "active", agent: "desk-bot" },
	});
	expect((await held(app, cookie)).map((item) => `${item.agent}@${item.label}`)).toEqual(["desk-bot@claude"]);
}, 120000);
