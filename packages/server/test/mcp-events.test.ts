import { assertionHeader } from "@comms/protocol/headers";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

type App = Awaited<ReturnType<Awaited<ReturnType<typeof conversation>>["launch"]>>;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) => Schema.decodeUnknownSync(schema)(value);
const secret = `whsec_${Buffer.alloc(32, 21).toString("base64")}`;
const Posted = Schema.Struct({ id: Schema.String, seq: Schema.Int, created_at: Schema.Int });
const Subscribed = Schema.Struct({
	result: Schema.Struct({
		id: Schema.String,
		refreshBefore: Schema.String,
		cursor: Schema.String,
		truncated: Schema.Boolean,
	}),
});
const Refused = Schema.Struct({
	error: Schema.Struct({ code: Schema.Int, message: Schema.String, data: Schema.optionalKey(Schema.Unknown) }),
});
const Delivery = Schema.fromJsonString(
	Schema.Struct({
		eventId: Schema.String,
		name: Schema.String,
		timestamp: Schema.String,
		data: Schema.Struct({
			id: Schema.String,
			topic: Schema.String,
			author: Schema.String,
			text: Schema.String,
			truncated: Schema.Boolean,
			url: Schema.String,
		}),
		cursor: Schema.NullOr(Schema.String),
	}),
);

/** A board with the MCP package installed and local callbacks allowed, with an optional source edit to events.ts. */
const installed = async (test: TestContext, edit = (source: string) => source) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await cp(join(import.meta.dirname, "../../../examples/extensions/mcp"), join(seed, "ext/mcp"), { recursive: true });
	for (const file of (await readdir(join(seed, "ext/mcp"))).filter((name) => name.endsWith(".ts"))) {
		const path = join(seed, "ext/mcp", file);
		const source = (await readFile(path, "utf8"))
			.replace("../../../packages/server/src/kernel/extension-api.ts", "../../kernel/extension-api.ts")
			.replace("https://your-board.example", "https://comms.test")
			.replace("const allowLocalCallbacks = false;", "const allowLocalCallbacks = true;");
		await writeFile(path, file === "events.ts" ? edit(source) : source);
	}
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, body: string) => {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		return decode(Posted, await response.json());
	};
	return { fixture, app, cookie, post };
};

/** The authorization request a registered client makes, approved by the signed-in human under `agent`. */
const authorize = async (app: App, cookie: string, name: string, agent: string, editing: boolean) => {
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
	};
	const form = (path: string, body: Readonly<Record<string, string>>) =>
		fetch(`${app.url}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { cookie, origin: "https://comms.test", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body),
		});
	const approved = await form("/mcp/oauth/authorize", {
		...query,
		decision: "approve",
		agent,
		...(editing ? { editing: "1" } : {}),
	});
	const location = editing
		? await (async () => {
				// Editing goes through boot's approval page, then back to the continue route that finishes connecting.
				const html = await approved.text();
				const approval = new URL(/href="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "");
				const id = approval.pathname.split("/").at(-1) ?? "";
				const scopes = ["read", "write"];
				const decided = await fetch(`${app.url}/_boot/enroll/${id}/approve`, {
					method: "POST",
					headers: {
						origin: "https://comms.test",
						"content-type": "application/json",
						[assertionHeader]: await app.assertion({ id, decision: "approve", scopes, long_lived: false }),
					},
					body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
				});
				expect(decided.status).toBe(200);
				const consent = new URL(approval.searchParams.get("return") ?? "", app.url).searchParams.get("consent") ?? "";
				return (await form("/mcp/oauth/continue", { consent })).headers.get("location");
			})()
		: approved.headers.get("location");
	const code = new URL(location ?? "").searchParams.get("code");
	if (!code) throw new Error("authorization code is missing");
	const exchanged = await fetch(`${app.url}/mcp/oauth/token`, {
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
	const access = decode(Schema.Struct({ access_token: Schema.String }), await exchanged.json()).access_token;
	return { clientId, ...client(app, access) };
};

/** MCP 2.0 requests for one connection: version and capabilities travel in `_meta`, mirrored by the headers. */
const client = (app: App, token: string) => {
	let id = 0;
	const call = async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
		const response = await fetch(`${app.url}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": method,
				...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++id,
				method,
				params: {
					...params,
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
		expect(response.status).toBe(200);
		return response.json();
	};
	const params = (url: string, name: string, args: unknown, cursor: string | null = null) => ({
		name,
		...(args === undefined ? {} : { arguments: args }),
		delivery: { mode: "webhook", url, secret },
		cursor,
	});
	return {
		call,
		subscribe: async (url: string, name: string, args: unknown, cursor: string | null = null) =>
			decode(Subscribed, await call("events/subscribe", params(url, name, args, cursor))).result,
		refused: async (url: string, name: string, args: unknown, cursor: string | null = null) =>
			decode(Refused, await call("events/subscribe", params(url, name, args, cursor))).error,
		unsubscribe: async (url: string, name: string, args: unknown) =>
			expect(await call("events/unsubscribe", { name, arguments: args, delivery: { mode: "webhook", url } })).toEqual(
				expect.objectContaining({ result: { resultType: "complete" } }),
			),
		post: async (topic: string, body: string, key: string) =>
			call("tools/call", { name: "post_message", arguments: { topic, body, idempotencyKey: key } }),
		edit: async (name: string, args: Readonly<Record<string, unknown>> = {}) =>
			call("tools/call", { name, arguments: args }),
	};
};

/** Revokes the connection's live mcp grant, as the human would from the token list. */
const revokeGrant = async (app: App, cookie: string, agent: string) => {
	const families = decode(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					family: Schema.String,
					agent: Schema.String,
					held_by: Schema.NullOr(Schema.String),
					revoked: Schema.Boolean,
				}),
			),
		}),
		await (await fetch(`${app.url}/_boot/tokens`, { headers: { cookie } })).json(),
	).items.filter((item) => item.held_by === "mcp" && item.agent === agent && !item.revoked);
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

/** Approves a pending `request_editing` grant the way the human does on boot's page. */
const approveEditing = async (app: App, approveUrl: string) => {
	const id = new URL(approveUrl).pathname.split("/").at(-1) ?? "";
	const scopes = ["read", "write"];
	const decided = await fetch(`${app.url}/_boot/enroll/${id}/approve`, {
		method: "POST",
		headers: {
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: await app.assertion({ id, decision: "approve", scopes, long_lived: false }),
		},
		body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
	});
	expect(decided.status, await decided.clone().text()).toBe(200);
};

/** A webhook endpoint that echoes verification challenges and records each delivered event with its subscription. */
const receiver = async (test: TestContext) => {
	const received: Array<{ readonly headers: Readonly<Record<string, string | string[] | undefined>>; body: string }> =
		[];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			received.push({ headers: request.headers, body });
			const challenge = Reflect.get(Object(JSON.parse(body)), "challenge");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(typeof challenge === "string" ? { challenge } : {}));
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
	const events = () =>
		received
			.filter((item) => !String(item.headers["webhook-id"]).startsWith("msg_"))
			.map((item) => ({
				subscription: String(item.headers["x-mcp-subscription-id"]),
				signed:
					item.headers["webhook-signature"] ===
					`v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
						.update(`${String(item.headers["webhook-id"])}.${String(item.headers["webhook-timestamp"])}.${item.body}`)
						.digest("base64")}`,
				...Schema.decodeSync(Delivery)(item.body),
			}));
	return {
		url: `http://127.0.0.1:${address.port}/hook`,
		verifications: () => received.filter((item) => String(item.headers["webhook-id"]).startsWith("msg_verification_")),
		events,
		/** Texts delivered to one subscription, in arrival order. */
		texts: (subscription: string) =>
			events()
				.filter((event) => event.subscription === subscription)
				.map((event) => event.data.text),
	};
};

/** Polls until `check` gives a value, for up to 30 seconds, so a slow, loaded run waits longer instead of failing. */
const until = async <A>(check: () => Promise<A | undefined> | A | undefined): Promise<A> => {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const value = await check();
		if (value !== undefined) return value;
		await delay(50);
	}
	throw new Error("condition was not met within 30 seconds");
};
const eventually = async (check: () => boolean) => {
	await until(() => (check() ? true : undefined));
};
/**
 * Returns once a whole delivery cycle that began after this call has finished, every subscription included. Cycles run
 * one after another, so the cycle that delivers the second marker began after the first marker arrived, and the third
 * marker arrives only after that cycle has finished.
 */
const settle = async (
	post: (topic: string, body: string) => Promise<unknown>,
	texts: () => ReadonlyArray<string>,
	topic: string,
) => {
	for (let n = 1; n <= 3; n++) {
		const marker = `settle ${n} ${Date.now()}`;
		await post(topic, marker);
		await eventually(() => texts().includes(marker));
	}
};

it("watches a topic with or without its subtopics and never delivers the connection's own posts", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const watcher = await authorize(app, cookie, "Watch client", "watch-bot", false);
	const hook = await receiver(test);

	const listed = await watcher.call("events/list", {});
	expect(listed).toMatchObject({
		result: {
			events: [
				{ name: "mention.created", inputSchema: { properties: { topic: {}, recursive: { default: true } } } },
				{ name: "message.created", delivery: ["webhook"], inputSchema: { required: ["topic"] } },
			],
		},
	});
	const info = await watcher.call("tools/call", { name: "connection_info" });
	expect(info).toMatchObject({
		result: { structuredContent: { delivery: { events: ["mention.created", "message.created"] } } },
	});

	// The topic must exist, and arguments must fit the event; nothing reaches the callback before both hold.
	expect(await watcher.refused(hook.url, "message.created", { topic: "plans" })).toEqual({
		code: -32011,
		message: "NotFound",
		data: { kind: "topic", topic: "plans" },
	});
	await post("plans", "kickoff");
	await post("plans/backend", "api notes");
	await post("elsewhere", "noise");
	// node_modules is a valid topic name, but the topic view cannot read pages under it.
	for (const args of [
		undefined,
		{},
		{ topic: "" },
		{ topic: "Plans!" },
		{ topic: "node_modules" },
		{ topic: "plans", channel: "x" },
	])
		expect(await watcher.refused(hook.url, "message.created", args), JSON.stringify(args)).toMatchObject({
			code: -32602,
		});
	expect(await watcher.refused(hook.url, "message.created", { topic: "plans" }, "not-a-cursor")).toMatchObject({
		code: -32602,
	});
	expect(hook.verifications()).toHaveLength(0);

	const subtree = await watcher.subscribe(hook.url, "message.created", { topic: "plans" });
	const exact = await watcher.subscribe(hook.url, "message.created", { topic: "plans", recursive: false });
	expect(subtree.id).not.toBe(exact.id);
	expect(subtree).toMatchObject({ cursor: expect.stringMatching(/^[0-9]+$/), truncated: false });
	// Key order is not identity, and one verification covers this client's callback for every subscription.
	expect((await watcher.subscribe(hook.url, "message.created", { recursive: false, topic: "plans" })).id).toBe(
		exact.id,
	);
	expect(hook.verifications()).toHaveLength(1);

	const top = await post("plans", "top level");
	await post("plans/backend", "nested");
	await post("elsewhere", "not watched");
	await watcher.post("plans", "the connection's own post", "own-1");
	await post("plans", "last");
	await eventually(() => hook.texts(subtree.id).includes("last") && hook.texts(exact.id).includes("last"));
	expect(hook.texts(subtree.id)).toEqual(["top level", "nested", "last"]);
	expect(hook.texts(exact.id)).toEqual(["top level", "last"]);
	const first = hook.events().find((event) => event.subscription === exact.id);
	expect(first).toEqual({
		subscription: exact.id,
		signed: true,
		eventId: `evt_${exact.id}_${top.seq}`,
		name: "message.created",
		timestamp: new Date(top.created_at).toISOString(),
		data: {
			id: `message:${top.seq}`,
			topic: "plans",
			author: "rahul",
			text: "top level",
			truncated: false,
			url: `https://comms.test/?message=${top.seq}#message-${top.seq}`,
		},
		cursor: String(top.seq),
	});

	// Unsubscribing one watch leaves the other delivering.
	await watcher.unsubscribe(hook.url, "message.created", { topic: "plans", recursive: false });
	await post("plans", "after");
	// The removed row is checked again before every delivery, so "after" can never reach it.
	await eventually(() => hook.texts(subtree.id).includes("after"));
	expect(hook.texts(exact.id)).toEqual(["top level", "last"]);

	// Default values do not count toward identity, so the other spelling refreshes, and then removes, the same row.
	expect((await watcher.subscribe(hook.url, "message.created", { topic: "plans", recursive: true })).id).toBe(
		subtree.id,
	);
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM example_mcp_events")).toEqual([{ count: 1 }]);
	await watcher.unsubscribe(hook.url, "message.created", { recursive: true, topic: "plans" });
	expect(await fixture.sql("SELECT COUNT(*) AS count FROM example_mcp_events")).toEqual([{ count: 0 }]);
}, 120000);

it("never delivers posts the connection made through its editing grant, while other agents' @here arrives", async (test) => {
	const { app, cookie, post } = await installed(test);
	await post("plans", "kickoff");
	const granted = await authorize(app, cookie, "Granted client", "grant-bot", true);
	const other = await authorize(app, cookie, "Other client", "other-bot", false);
	const hook = await receiver(test);
	const mentions = await granted.subscribe(hook.url, "mention.created", {});
	const watch = await granted.subscribe(hook.url, "message.created", { topic: "plans" });
	// Posted through the grant, so each message is the agent's own and its instance is the grant family.
	for (const { body, key } of [
		{ body: "@here from grant-bot", key: "grant-1" },
		{ body: "@grant-bot note to self", key: "grant-2" },
	])
		expect(await granted.post("plans", body, key)).toMatchObject({
			result: { structuredContent: { agent: "grant-bot", instance: expect.stringMatching(/^f_/) } },
		});
	await other.post("plans", "@here from another connection", "other-1");
	await post("plans", "@here standup");
	// Delivery is in order, so once the last post arrives every earlier one has been delivered or skipped.
	await eventually(
		() => hook.texts(mentions.id).includes("@here standup") && hook.texts(watch.id).includes("@here standup"),
	);
	expect(hook.texts(mentions.id)).toEqual(["@here from another connection", "@here standup"]);
	expect(hook.texts(watch.id)).toEqual(["@here from another connection", "@here standup"]);
	const same = hook.events().filter((event) => event.data.text === "@here standup");
	expect(same).toHaveLength(2);
	expect(same[0]?.eventId).not.toBe(same[1]?.eventId);
	expect(new Set(same.map((event) => event.eventId))).toEqual(
		new Set([`evt_${mentions.id}_${same[0]?.cursor}`, `evt_${watch.id}_${same[0]?.cursor}`]),
	);
}, 120000);

it("does not replay posts from a replaced editing grant", async (test) => {
	const { app, cookie, post } = await installed(test);
	const kickoff = await post("plans", "kickoff");
	const granted = await authorize(app, cookie, "Granted client", "grant-bot", true);
	const other = await authorize(app, cookie, "Other client", "other-bot", false);
	const hook = await receiver(test);
	expect(await granted.post("plans", "@here from the first grant", "own-1")).toMatchObject({
		result: { structuredContent: { instance: expect.stringMatching(/^f_/) } },
	});
	await other.post("plans", "@here from another connection", "other-1");
	await revokeGrant(app, cookie, "grant-bot");
	expect(await granted.edit("request_editing")).toMatchObject({
		result: { structuredContent: { status: "pending" } },
	});
	const mentions = await granted.subscribe(hook.url, "mention.created", {}, String(kickoff.seq));
	await post("plans", "@here after replacement");
	await eventually(() => hook.texts(mentions.id).includes("@here after replacement"));
	expect(hook.texts(mentions.id)).toEqual(["@here from another connection", "@here after replacement"]);
}, 120000);

it("persists every retained grant family on the subscription after the grant row changes identity", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const kickoff = await post("plans", "kickoff");
	const granted = await authorize(app, cookie, "Family client", "family-bot", true);
	const other = await authorize(app, cookie, "Other family client", "other-family", false);
	const hook = await receiver(test);
	const first = decode(
		Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ instance: Schema.String }) }) }),
		await granted.post("plans", "@here from the first family", "fam-1"),
	).result.structuredContent.instance;
	expect(first).toMatch(/^f_/);
	await revokeGrant(app, cookie, "family-bot");
	const requested = decode(
		Schema.Struct({
			result: Schema.Struct({
				structuredContent: Schema.Struct({ status: Schema.String, approve_url: Schema.String }),
			}),
		}),
		await granted.edit("request_editing"),
	).result.structuredContent;
	expect(requested.status).toBe("pending");
	await approveEditing(app, requested.approve_url);
	expect(await granted.edit("request_editing")).toMatchObject({
		result: { structuredContent: { status: "active" } },
	});
	const second = decode(
		Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ instance: Schema.String }) }) }),
		await granted.post("plans", "@here from the second family", "fam-2"),
	).result.structuredContent.instance;
	expect(second).toMatch(/^f_/);
	expect(second).not.toBe(first);
	await other.post("plans", "@here from another connection", "fam-other");
	const mentions = await granted.subscribe(hook.url, "mention.created", {}, String(kickoff.seq));
	const [row] = decode(
		Schema.Array(Schema.Struct({ grant_family: Schema.NullOr(Schema.String) })),
		await fixture.sql(`SELECT grant_family FROM example_mcp_events WHERE id='${mentions.id}'`),
	);
	expect(row?.grant_family?.split(" ").sort()).toEqual([first, second].sort());
	await fixture.sql(
		`UPDATE example_mcp_grants SET agent='renamed-bot',family=NULL,families=NULL WHERE client_id='${granted.clientId}'`,
	);
	await post("plans", "@here after the grant identity changed");
	await eventually(() => hook.texts(mentions.id).includes("@here after the grant identity changed"));
	expect(hook.texts(mentions.id)).toEqual(["@here from another connection", "@here after the grant identity changed"]);
}, 120000);

it("copies a replacement grant family onto live subscriptions before the next drain", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const granted = await authorize(app, cookie, "Live family client", "live-fam", true);
	const other = await authorize(app, cookie, "Live other client", "live-other", false);
	const hook = await receiver(test);
	const first = decode(
		Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ instance: Schema.String }) }) }),
		await granted.post("plans", "@here from the first live family", "live-1"),
	).result.structuredContent.instance;
	const mentions = await granted.subscribe(hook.url, "mention.created", {});
	await revokeGrant(app, cookie, "live-fam");
	const requested = decode(
		Schema.Struct({
			result: Schema.Struct({
				structuredContent: Schema.Struct({ status: Schema.String, approve_url: Schema.String }),
			}),
		}),
		await granted.edit("request_editing"),
	).result.structuredContent;
	await approveEditing(app, requested.approve_url);
	expect(await granted.edit("request_editing")).toMatchObject({
		result: { structuredContent: { status: "active" } },
	});
	const second = decode(
		Schema.Struct({
			items: Schema.Array(
				Schema.Struct({
					family: Schema.String,
					agent: Schema.String,
					held_by: Schema.NullOr(Schema.String),
					revoked: Schema.Boolean,
				}),
			),
		}),
		await (await fetch(`${app.url}/_boot/tokens`, { headers: { cookie } })).json(),
	).items.find((item) => item.held_by === "mcp" && item.agent === "live-fam" && !item.revoked)?.family;
	expect(second).toMatch(/^f_/);
	expect(second).not.toBe(first);
	const [row] = decode(
		Schema.Array(Schema.Struct({ grant_family: Schema.NullOr(Schema.String) })),
		await fixture.sql(`SELECT grant_family FROM example_mcp_events WHERE id='${mentions.id}'`),
	);
	expect(row?.grant_family?.split(" ").sort()).toEqual([first, second].sort());
	const queued = decode(
		Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ instance: Schema.String }) }) }),
		await granted.post("plans", "@here from the second live family", "live-2"),
	).result.structuredContent.instance;
	expect(queued).toBe(second);
	await fixture.sql(
		`UPDATE example_mcp_grants SET agent='renamed-live',family=NULL,families=NULL WHERE client_id='${granted.clientId}'`,
	);
	await other.post("plans", "@here after the live grant identity changed", "live-other");
	await eventually(() => hook.texts(mentions.id).includes("@here after the live grant identity changed"));
	expect(hook.texts(mentions.id)).toEqual(["@here after the live grant identity changed"]);
}, 120000);

it("does not echo a replaced grant's posts across a multi-page drain", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const granted = await authorize(app, cookie, "Paged family client", "page-fam", true);
	const other = await authorize(app, cookie, "Paged other client", "page-other", false);
	const hook = await receiver(test);
	await post("plans", "setup");
	const mentions = await granted.subscribe(hook.url, "mention.created", {});
	await post("plans", "@page-fam ready");
	await eventually(() => hook.texts(mentions.id).includes("@page-fam ready"));
	// Hold delivery so more than one drain page of F1 posts can queue before replacement.
	await fixture.sql(`UPDATE example_mcp_events SET next_attempt=${Date.now() + 3_600_000} WHERE id='${mentions.id}'`);
	for (let n = 1; n <= 17; n++)
		expect(await granted.post("plans", `@here own ${n}`, `page-own-${n}`)).toMatchObject({
			result: { structuredContent: { instance: expect.stringMatching(/^f_/) } },
		});
	for (let n = 1; n <= 17; n++) await other.post("plans", `@here other ${n}`, `page-other-${n}`);
	await revokeGrant(app, cookie, "page-fam");
	const requested = decode(
		Schema.Struct({
			result: Schema.Struct({
				structuredContent: Schema.Struct({ status: Schema.String, approve_url: Schema.String }),
			}),
		}),
		await granted.edit("request_editing"),
	).result.structuredContent;
	await approveEditing(app, requested.approve_url);
	expect(await granted.edit("request_editing")).toMatchObject({
		result: { structuredContent: { status: "active" } },
	});
	await fixture.sql(`UPDATE example_mcp_events SET next_attempt=0 WHERE id='${mentions.id}'`);
	await post("plans", "@here after multi-page replacement");
	await eventually(() => hook.texts(mentions.id).includes("@here after multi-page replacement"));
	expect(hook.texts(mentions.id)).toEqual([
		"@page-fam ready",
		...Array.from({ length: 17 }, (_, n) => `@here other ${n + 1}`),
		"@here after multi-page replacement",
	]);
}, 120000);

it("does not let own-family posts fill the replay window past an older deliverable", async (test) => {
	const { app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayScan = 200;", "const replayScan = 4;"),
	);
	const granted = await authorize(app, cookie, "Window family client", "window-fam", true);
	const other = await authorize(app, cookie, "Window other client", "window-other", false);
	const hook = await receiver(test);
	await post("watched", "setup");
	const started = await granted.subscribe(hook.url, "mention.created", { topic: "watched" });
	await granted.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	await other.post("watched", "@window-fam older deliverable", "win-older");
	for (let n = 1; n <= 5; n++)
		expect(await granted.post("watched", `@here own ${n}`, `win-own-${n}`)).toMatchObject({
			result: { structuredContent: { instance: expect.stringMatching(/^f_/) } },
		});
	expect(await granted.subscribe(hook.url, "mention.created", { topic: "watched" }, started.cursor)).toMatchObject({
		truncated: false,
	});
	await eventually(() => hook.texts(started.id).includes("@window-fam older deliverable"));
	expect(hook.texts(started.id)).toEqual(["@window-fam older deliverable"]);
}, 120000);

it("narrows mention events to a topic while the whole-board subscription keeps its id", async (test) => {
	const { app, cookie, post } = await installed(test);
	const mentioned = await authorize(app, cookie, "Mention client", "mention-bot", false);
	const hook = await receiver(test);
	await post("plans", "setup");
	expect(await mentioned.refused(hook.url, "mention.created", { topic: "" })).toMatchObject({ code: -32602 });
	expect(await mentioned.refused(hook.url, "mention.created", { topic: "nowhere" })).toMatchObject({
		code: -32011,
		data: { kind: "topic" },
	});

	const board = await mentioned.subscribe(hook.url, "mention.created", {});
	// The id every mention subscription had before events took arguments, with or without an empty `arguments`.
	expect(board.id).toBe(
		`sub_${createHash("sha256")
			.update(JSON.stringify([mentioned.clientId, hook.url, "mention.created", {}]))
			.digest("hex")
			.slice(0, 32)}`,
	);
	expect((await mentioned.subscribe(hook.url, "mention.created", undefined)).id).toBe(board.id);
	expect((await mentioned.subscribe(hook.url, "mention.created", { recursive: false })).id).toBe(board.id);
	const scoped = await mentioned.subscribe(hook.url, "mention.created", { topic: "plans" });
	const exact = await mentioned.subscribe(hook.url, "mention.created", { topic: "plans", recursive: false });
	expect(new Set([board.id, scoped.id, exact.id]).size).toBe(3);

	await post("plans", "@mention-bot in plans");
	await post("elsewhere", "@mention-bot elsewhere");
	await post("plans/sub", "@here nested");
	await post("plans", "no mention here");
	await post("plans", "@mention-bot last");
	await eventually(() => [board.id, scoped.id, exact.id].every((id) => hook.texts(id).includes("@mention-bot last")));
	expect(hook.texts(board.id)).toEqual([
		"@mention-bot in plans",
		"@mention-bot elsewhere",
		"@here nested",
		"@mention-bot last",
	]);
	expect(hook.texts(scoped.id)).toEqual(["@mention-bot in plans", "@here nested", "@mention-bot last"]);
	expect(hook.texts(exact.id)).toEqual(["@mention-bot in plans", "@mention-bot last"]);
}, 120000);

it("resumes from a cursor with exactly the missed messages, in order and without duplicates", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const resumer = await authorize(app, cookie, "Replay client", "replay-bot", false);
	const hook = await receiver(test);
	await post("replay", "setup");
	const started = await resumer.subscribe(hook.url, "message.created", { topic: "replay" });
	const first = await post("replay", "m1");
	await eventually(() => hook.texts(started.id).includes("m1"));
	const cursor = hook.events().at(-1)?.cursor ?? null;
	expect(cursor).toBe(String(first.seq));
	// The receiver sees m1 before delivery records it, so wait for the stored position to pass it.
	await until(async () => {
		const [row] = decode(
			Schema.Array(Schema.Struct({ position: Schema.Finite })),
			await fixture.sql(`SELECT position FROM example_mcp_events WHERE id='${started.id}'`),
		);
		return row !== undefined && row.position >= first.seq ? row : undefined;
	});
	// While live, a refresh carrying an older cursor changes nothing and reports the subscription's own position.
	const refreshed = await resumer.subscribe(hook.url, "message.created", { topic: "replay" }, started.cursor);
	expect(refreshed.id).toBe(started.id);
	expect(Number(refreshed.cursor)).toBeGreaterThanOrEqual(first.seq);

	await resumer.unsubscribe(hook.url, "message.created", { topic: "replay" });
	const missed = [await post("replay", "m2"), await post("replay", "m3"), await post("replay", "m4")];
	const resumed = await resumer.subscribe(hook.url, "message.created", { topic: "replay" }, cursor);
	expect(resumed).toEqual({ id: started.id, refreshBefore: expect.any(String), cursor, truncated: false });
	const live = await post("replay", "m5");
	await eventually(() => hook.texts(started.id).includes("m5"));
	const delivered = hook.events().filter((event) => event.subscription === started.id);
	expect(delivered.map((event) => event.data.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
	expect(delivered.map((event) => event.cursor)).toEqual(
		[first, ...missed, live].map((message) => String(message.seq)),
	);

	// The board drops the row, as expiry or a lost grant would. Created again from the first cursor, the subscription
	// replays everything after it, even though delivery had already read that far for the row it replaces.
	await fixture.sql("DELETE FROM example_mcp_events");
	expect(await resumer.subscribe(hook.url, "message.created", { topic: "replay" }, started.cursor)).toMatchObject({
		cursor: started.cursor,
		truncated: false,
	});
	await eventually(() => hook.texts(started.id).length === 10);
	expect(hook.texts(started.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m1", "m2", "m3", "m4", "m5"]);
}, 120000);

it("bounds a replay by the messages it matches and reports truncated only when it skipped some", async (test) => {
	const { app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayLimit = 100;", "const replayLimit = 3;"),
	);
	const resumer = await authorize(app, cookie, "Truncated client", "trunc-bot", false);
	const hook = await receiver(test);
	await post("trunc", "setup");
	const watch = { topic: "trunc" };
	const started = await resumer.subscribe(hook.url, "message.created", watch);
	await resumer.unsubscribe(hook.url, "message.created", watch);
	// Messages the watch does not match never count against the cap, however many board sequence numbers they use.
	for (let n = 1; n <= 8; n++) await post("elsewhere", `noise ${n}`);
	await post("trunc", "a1");
	await post("trunc", "a2");
	expect(await resumer.subscribe(hook.url, "message.created", watch, started.cursor)).toMatchObject({
		cursor: started.cursor,
		truncated: false,
	});
	await eventually(() => hook.texts(started.id).includes("a2"));
	const cursor = hook.events().at(-1)?.cursor ?? null;
	await resumer.unsubscribe(hook.url, "message.created", watch);
	const missed: Array<number> = [];
	for (let n = 1; n <= 5; n++) missed.push((await post("trunc", `b${n}`)).seq);
	// Past the newest three matches, the replay starts after the one just older and says it skipped some.
	expect(await resumer.subscribe(hook.url, "message.created", watch, cursor)).toMatchObject({
		cursor: String(missed[1]),
		truncated: true,
	});
	await post("trunc", "after");
	await eventually(() => hook.texts(started.id).includes("after"));
	expect(hook.texts(started.id)).toEqual(["a1", "a2", "b3", "b4", "b5", "after"]);

	// A cursor beyond the board's head, as after a restore, starts from the head rather than refusing or stalling.
	await resumer.unsubscribe(hook.url, "message.created", watch);
	const ahead = await resumer.subscribe(hook.url, "message.created", watch, "999999999");
	expect(ahead.truncated).toBe(false);
	expect(Number(ahead.cursor)).toBeLessThan(999999999);
	await post("trunc", "after the head");
	await eventually(() => hook.texts(started.id).includes("after the head"));
}, 120000);

it("starts a replay that fills its candidate window at the oldest one, truncated only when older ones exist", async (test) => {
	const { app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayScan = 200;", "const replayScan = 4;"),
	);
	const resumer = await authorize(app, cookie, "Window client", "window-bot", false);
	const hook = await receiver(test);
	await post("window", "setup");
	const watch = { topic: "window" };
	const started = await resumer.subscribe(hook.url, "message.created", watch);
	await resumer.unsubscribe(hook.url, "message.created", watch);
	// Exactly a window's worth missed: nothing older exists, so all four replay and nothing was skipped.
	const four: Array<number> = [];
	for (let n = 1; n <= 4; n++) four.push((await post("window", `w${n}`)).seq);
	expect(await resumer.subscribe(hook.url, "message.created", watch, started.cursor)).toMatchObject({
		cursor: String((four[0] ?? 0) - 1),
		truncated: false,
	});
	await eventually(() => hook.texts(started.id).includes("w4"));
	expect(hook.texts(started.id)).toEqual(["w1", "w2", "w3", "w4"]);
	// Six missed: the window holds the newest four, which replay, and the two older ones are skipped.
	const cursor = hook.events().at(-1)?.cursor ?? null;
	await resumer.unsubscribe(hook.url, "message.created", watch);
	const six: Array<number> = [];
	for (let n = 1; n <= 6; n++) six.push((await post("window", `x${n}`)).seq);
	expect(await resumer.subscribe(hook.url, "message.created", watch, cursor)).toMatchObject({
		cursor: String((six[2] ?? 0) - 1),
		truncated: true,
	});
	await eventually(() => hook.texts(started.id).includes("x6"));
	expect(hook.texts(started.id)).toEqual(["w1", "w2", "w3", "w4", "x3", "x4", "x5", "x6"]);
}, 120000);

it("charges replays to the verification budget even when the callback is already verified", async (test) => {
	const { app, cookie, post } = await installed(test);
	const client = await authorize(app, cookie, "Budget client", "budget-bot", false);
	const hook = await receiver(test);
	await post("budget", "setup");
	// The live mention subscription keeps this callback verified, so below only the replays spend the budget.
	const anchor = await client.subscribe(hook.url, "mention.created", {});
	await post("budget", "missed");
	const watch = { topic: "budget" };
	for (let n = 1; n < 10; n++) {
		expect(await client.subscribe(hook.url, "message.created", watch, anchor.cursor)).toMatchObject({
			cursor: anchor.cursor,
		});
		await client.unsubscribe(hook.url, "message.created", watch);
	}
	expect(hook.verifications()).toHaveLength(1);
	expect(await client.refused(hook.url, "message.created", watch, anchor.cursor)).toEqual({
		code: -32013,
		message: "ResourceExhausted",
		data: { limit: "verifications", max: 10 },
	});
	// Starting from now replays nothing, so it is not charged.
	expect(await client.subscribe(hook.url, "message.created", watch)).toMatchObject({ truncated: false });
}, 120000);

it("keeps delivering mention subscriptions created before events took arguments", async (test) => {
	// The previous package had no topic columns, so its table and rows are what the live board holds.
	const ladder = /\t\t\/\/ Topic watches came later[\s\S]*?(?=\t\tconst rows = \(ctx: Store)/;
	const { fixture, app, cookie, post } = await installed(test, (source) => source.replace(ladder, ""));
	const columns = async () =>
		decode(
			Schema.Array(Schema.Struct({ name: Schema.String })),
			await fixture.sql("SELECT name FROM pragma_table_info('example_mcp_events')"),
		).map((column) => column.name);
	expect(await columns()).not.toContain("event_name");
	const legacy = await authorize(app, cookie, "Legacy client", "legacy-bot", false);
	const hook = await receiver(test);
	const start = await post("legacy", "setup");
	const id = `sub_${createHash("sha256")
		.update(JSON.stringify([legacy.clientId, hook.url, "mention.created", {}]))
		.digest("hex")
		.slice(0, 32)}`;
	await fixture.sql(
		`INSERT INTO example_mcp_events(id,client_id,agent,instance,url,secret,previous_secret,previous_secret_until,refresh_before,verified_at,position,attempts,next_attempt,last_error) VALUES('${id}','${legacy.clientId}','legacy-bot','extension:mcp:${legacy.clientId}','${hook.url}','${secret}',NULL,NULL,${Date.now() + 3600000},${Date.now()},${start.seq},0,0,NULL)`,
	);

	const headers = { cookie, origin: "https://comms.test" };
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const current = await fetch(`${app.url}/api/fs/app/ext/mcp/events.ts`, { headers });
	const upgraded = (
		await readFile(join(import.meta.dirname, "../../../examples/extensions/mcp/events.ts"), "utf8")
	).replace("../../../packages/server/src/kernel/extension-api.ts", "../../kernel/extension-api.ts");
	const staged = await fetch(
		`${app.url}/api/fs/app/ext/mcp/events.ts?reload=0&baseVersion=${current.headers.get("x-chirp-base-version")}`,
		{
			method: "PUT",
			headers,
			body: upgraded.replace("const allowLocalCallbacks = false;", "const allowLocalCallbacks = true;"),
		},
	);
	expect(staged.status).toBe(200);
	expect(await (await app.post("/api/reload?release=1", {}, cookie)).json()).toMatchObject({ status: "live" });
	expect(await columns()).toEqual(expect.arrayContaining(["event_name", "topic", "subtopics"]));
	expect(await fixture.sql(`SELECT event_name,topic,subtopics FROM example_mcp_events WHERE id='${id}'`)).toEqual([
		{ event_name: "mention.created", topic: null, subtopics: 1 },
	]);

	const mention = await post("legacy", "still there, @legacy-bot?");
	await eventually(() => hook.texts(id).length > 0);
	expect(hook.events()).toMatchObject([
		{ subscription: id, signed: true, name: "mention.created", eventId: `evt_${id}_${mention.seq}` },
	]);
	// The client's next refresh finds the same subscription rather than creating another.
	expect((await legacy.subscribe(hook.url, "mention.created", {})).id).toBe(id);
	expect(hook.verifications()).toHaveLength(0);
	expect(await fixture.sql(`SELECT COUNT(*) AS count FROM example_mcp_events`)).toEqual([{ count: 1 }]);
}, 120000);

it("pages of the connection's own grant posts neither stall the cursor nor skip other agents' messages", async (test) => {
	// With the cap at three, the connection's 48 own posts would cut the three real matches if they counted toward it.
	const { fixture, app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayLimit = 100;", "const replayLimit = 3;"),
	);
	const kickoff = await post("plans", "kickoff");
	const granted = await authorize(app, cookie, "Granted client", "grant-bot", true);
	const other = await authorize(app, cookie, "Other client", "other-bot", false);
	const hook = await receiver(test);
	const own = async (prefix: string, count: number) => {
		for (let n = 0; n < count; n++)
			expect(await granted.post("plans", `@here own ${prefix}${n}`, `own-${prefix}-${n}`)).toMatchObject({
				result: { structuredContent: { instance: expect.stringMatching(/^f_/) } },
			});
	};
	// Replaying from kickoff makes the 16-message pages deterministic: 15 own and another agent's post, then 16 own (a
	// full page that matches nothing), then another agent's post and 15 own, then one own and the human's.
	await own("a", 15);
	await other.post("plans", "@here other 1", "other-1");
	await own("b", 16);
	await other.post("plans", "@here other 2", "other-2");
	await own("c", 16);
	const last = await post("plans", "@here human last");
	const mentions = await granted.subscribe(hook.url, "mention.created", {}, String(kickoff.seq));
	const watch = await granted.subscribe(hook.url, "message.created", { topic: "plans" }, String(kickoff.seq));
	for (const subscribed of [mentions, watch])
		expect(subscribed).toMatchObject({ cursor: String(kickoff.seq), truncated: false });
	await eventually(() => [mentions.id, watch.id].every((id) => hook.texts(id).includes("@here human last")));
	for (const id of [mentions.id, watch.id])
		expect(hook.texts(id)).toEqual(["@here other 1", "@here other 2", "@here human last"]);
	// Delivery records each position after the receiver answers, so wait for both to pass the last message.
	const rows = await until(async () => {
		const found = decode(
			Schema.Array(Schema.Struct({ position: Schema.Finite, attempts: Schema.Finite })),
			await fixture.sql("SELECT position,attempts FROM example_mcp_events"),
		);
		return found.length === 2 && found.every((row) => row.position >= last.seq) ? found : undefined;
	});
	for (const row of rows) expect(row.attempts).toBe(0);
}, 120000);

it("leaves idle cursors alone between board requests and backs off only a subscription that fails", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const client = await authorize(app, cookie, "Isolated client", "iso-bot", false);
	const hook = await receiver(test);
	await post("iso", "setup");
	const mentions = await client.subscribe(hook.url, "mention.created", {});
	const stored = async (id: string) =>
		decode(
			Schema.Array(
				Schema.Struct({
					position: Schema.Finite,
					next_attempt: Schema.Finite,
					last_error: Schema.NullOr(Schema.String),
				}),
			),
			await fixture.sql(`SELECT position,next_attempt,last_error FROM example_mcp_events WHERE id='${id}'`),
		)[0];
	// Board requests advance the event fence and wake delivery, but an idle subscription does not write on each one.
	for (let n = 0; n < 20; n++) await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } });
	const later = await client.subscribe(hook.url, "message.created", { topic: "iso" });
	expect(Number(later.cursor)).toBeGreaterThan(Number(mentions.cursor));
	expect((await stored(mentions.id))?.position).toBe(Number(mentions.cursor));
	await settle(post, () => hook.texts(later.id), "iso");

	// A row the board refuses to query backs off alone, and the healthy subscriptions still deliver.
	await fixture.sql(
		`INSERT INTO example_mcp_events(id,client_id,agent,instance,url,secret,previous_secret,previous_secret_until,refresh_before,verified_at,position,attempts,next_attempt,last_error,event_name,topic,subtopics) VALUES('sub_broken','${client.clientId}','iso-bot','extension:mcp:${client.clientId}','${hook.url}','${secret}',NULL,NULL,${Date.now() + 3600000},${Date.now()},0,0,0,NULL,'message.created','Not A Topic',1)`,
	);
	await post("iso", "@iso-bot still delivered");
	await eventually(
		() =>
			hook.texts(mentions.id).includes("@iso-bot still delivered") &&
			hook.texts(later.id).includes("@iso-bot still delivered"),
	);
	// It records why and backs off briefly, doubling: a row is not tried again before its next_attempt, and every
	// back-off after the first is at least four seconds, so two failures inside the wait prove the first was short.
	const failed = await until(async () => {
		const row = await stored("sub_broken");
		return row?.last_error === "drain_failed" ? row : undefined;
	});
	const again = await until(async () => {
		const row = await stored("sub_broken");
		return row !== undefined && row.next_attempt !== failed.next_attempt ? row : undefined;
	});
	expect(again.last_error).toBe("drain_failed");
	expect(again.next_attempt - failed.next_attempt).toBeGreaterThanOrEqual(4_000);
}, 120000);

it("records drain backoff at the checkpointed position after partial progress", async (test) => {
	const { fixture, app, cookie, post } = await installed(test, (source) =>
		source.replace(
			"return { wake: now + 60_000, backlog: page.items.length === 16 };",
			'if (position !== row.position) return yield* Effect.die("after progress");\n\t\t\t\treturn { wake: now + 60_000, backlog: page.items.length === 16 };',
		),
	);
	const client = await authorize(app, cookie, "Backoff client", "back-bot", false);
	const hook = await receiver(test);
	await post("back", "setup");
	const mentions = await client.subscribe(hook.url, "mention.created", {});
	await post("back", "@back-bot first");
	await post("back", "@back-bot second");
	const failed = await until(async () => {
		const [row] = decode(
			Schema.Array(
				Schema.Struct({
					position: Schema.Finite,
					next_attempt: Schema.Finite,
					last_error: Schema.NullOr(Schema.String),
				}),
			),
			await fixture.sql(`SELECT position,next_attempt,last_error FROM example_mcp_events WHERE id='${mentions.id}'`),
		);
		return row?.last_error === "drain_failed" && row.position > Number(mentions.cursor) ? row : undefined;
	});
	expect(failed.next_attempt).toBeGreaterThan(Date.now());
	await eventually(() => hook.texts(mentions.id).includes("@back-bot first"));
}, 120000);

it("never delivers again a message that an edit made match after delivery had read it", async (test) => {
	const { app, cookie, post } = await installed(test);
	const editor = await authorize(app, cookie, "Edit client", "edit-bot", false);
	const hook = await receiver(test);
	await post("plans", "setup");
	const mentions = await editor.subscribe(hook.url, "mention.created", {});
	const watch = await editor.subscribe(hook.url, "message.created", { topic: "plans" });
	// Idle cycles read past the draft with nothing to send, so the stored cursor stays behind it.
	const draft = await post("plans", "draft without a mention");
	for (let n = 0; n < 5; n++) await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } });
	await settle(post, () => hook.texts(watch.id), "plans");
	const edited = await fetch(`${app.url}/api/messages/${draft.id}`, {
		method: "PATCH",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ body: "draft for @edit-bot" }),
	});
	expect(edited.status).toBe(200);
	await post("plans", "@edit-bot after the edit");
	await eventually(() => hook.texts(mentions.id).includes("@edit-bot after the edit"));
	expect(hook.texts(mentions.id)).toEqual(["@edit-bot after the edit"]);
}, 120000);

it("reports truncated for a topic mention replay only when it skipped a matching mention", async (test) => {
	const { app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayScan = 200;", "const replayScan = 4;"),
	);
	const mentioned = await authorize(app, cookie, "Filtered replay client", "filter-bot", false);
	const hook = await receiver(test);
	await post("watched", "setup");
	const scoped = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	// A full window of other-topic mentions must not count as skipped deliveries for this watch.
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot other ${n}`);
	await post("watched", "@filter-bot keep 1");
	await post("watched", "@filter-bot keep 2");
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, scoped.cursor)).toMatchObject({
		truncated: false,
	});
	await eventually(() => hook.texts(scoped.id).includes("@filter-bot keep 2"));
	expect(hook.texts(scoped.id)).toEqual(["@filter-bot keep 1", "@filter-bot keep 2"]);
	const cursor = hook.events().at(-1)?.cursor ?? null;
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	await post("watched", "@filter-bot skipped");
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot noise ${n}`);
	await post("watched", "@filter-bot kept");
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, cursor)).toMatchObject({
		truncated: true,
	});
	await eventually(() => hook.texts(scoped.id).includes("@filter-bot kept"));
	expect(hook.texts(scoped.id)).toEqual(["@filter-bot keep 1", "@filter-bot keep 2", "@filter-bot kept"]);
	// More than two candidate pages: an unexamined middle is still truncated, without scanning history.
	const after = hook.events().at(-1)?.cursor ?? null;
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot head ${n}`);
	await post("watched", "@filter-bot middle");
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot tail ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, after)).toMatchObject({
		truncated: true,
	});
	// Exactly two candidate pages of other-topic mentions meet at the window; nothing deliverable was skipped.
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	const fresh = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	for (let n = 1; n <= 8; n++) await post("elsewhere", `@filter-bot pair ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, fresh.cursor)).toMatchObject({
		truncated: false,
	});
	// More than two pages of other-topic mentions: a gap exists, but none of it matches this watch.
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	const quiet = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot head-gap ${n}`);
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot mid-gap ${n}`);
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot tail-gap ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, quiet.cursor)).toMatchObject({
		truncated: false,
	});
	// A matching mention past three broad candidate pages is still truncated.
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	const deep = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot p1 ${n}`);
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot p2 ${n}`);
	await post("watched", "@filter-bot deep");
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot p3 ${n}`);
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@filter-bot p4 ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, deep.cursor)).toMatchObject({
		truncated: true,
	});
}, 120000);

it("reports truncated when a deliverable match lies past a full read of the gap", async (test) => {
	const { app, cookie, post } = await installed(test, (source) =>
		source.replace("const replayScan = 200;", "const replayScan = 4;"),
	);
	const mentioned = await authorize(app, cookie, "Deep gap client", "deep-bot", false);
	const hook = await receiver(test);
	await post("watched", "setup");
	const started = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	// A full page of mentions elsewhere, then more than replayScan ordinary posts in the watched topic, then the
	// one deliverable mention, then a full newest window elsewhere: a topic-only limit would miss the mention.
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@deep-bot early ${n}`);
	for (let n = 1; n <= 5; n++) await post("watched", `chatter ${n}`);
	await post("watched", "@deep-bot in the gap");
	for (let n = 1; n <= 4; n++) await post("elsewhere", `@deep-bot late ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, started.cursor)).toMatchObject({
		truncated: true,
	});
}, 120000);

it("keeps a full 200-candidate replay look-back within the message query limit", async (test) => {
	const { app, cookie, post } = await installed(test);
	const mentioned = await authorize(app, cookie, "Bound replay client", "bound-bot", false);
	const hook = await receiver(test);
	await post("watched", "setup");
	const scoped = await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" });
	await mentioned.unsubscribe(hook.url, "mention.created", { topic: "watched" });
	for (let n = 1; n <= 200; n++) await post("elsewhere", `@bound-bot noise ${n}`);
	expect(await mentioned.subscribe(hook.url, "mention.created", { topic: "watched" }, scoped.cursor)).toMatchObject({
		truncated: false,
	});
}, 180000);

it("persists idle scan progress so a reload cannot re-emit an edited message", async (test) => {
	const { fixture, app, cookie, post } = await installed(test);
	const editor = await authorize(app, cookie, "Reload edit client", "reload-bot", false);
	const hook = await receiver(test);
	await post("plans", "setup");
	const mentions = await editor.subscribe(hook.url, "mention.created", {});
	const draft = await post("plans", "draft without a mention");
	await until(async () => {
		const [row] = decode(
			Schema.Array(Schema.Struct({ position: Schema.Finite })),
			await fixture.sql(`SELECT position FROM example_mcp_events WHERE id='${mentions.id}'`),
		);
		return row !== undefined && row.position >= draft.seq ? row : undefined;
	});
	const headers = { cookie, origin: "https://comms.test" };
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const current = await fetch(`${app.url}/api/fs/app/ext/mcp/events.ts`, { headers });
	const staged = await fetch(
		`${app.url}/api/fs/app/ext/mcp/events.ts?reload=0&baseVersion=${current.headers.get("x-chirp-base-version")}`,
		{
			method: "PUT",
			headers,
			body: `${await current.text()}// persisted watermark\n`,
		},
	);
	expect(staged.status).toBe(200);
	expect(await (await app.post("/api/reload?release=1", {}, cookie)).json()).toMatchObject({ status: "live" });
	const edited = await fetch(`${app.url}/api/messages/${draft.id}`, {
		method: "PATCH",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
		body: JSON.stringify({ body: "draft for @reload-bot" }),
	});
	expect(edited.status).toBe(200);
	await post("plans", "@reload-bot after reload");
	await eventually(() => hook.texts(mentions.id).includes("@reload-bot after reload"));
	expect(hook.texts(mentions.id)).toEqual(["@reload-bot after reload"]);
}, 120000);

it("does not skip a mention published between an idle scan and its watermark read", async (test) => {
	const { fixture, app, cookie, post } = await installed(test, (source) =>
		source.replace(
			"(yield* ctx.messages.query({ since: position, newest: true, limit: 1 })).items[0];",
			"yield* Effect.sleep(400).pipe(Effect.andThen(ctx.messages.query({ since: position, newest: true, limit: 1 })), Effect.map((found) => found.items[0]));",
		),
	);
	const editor = await authorize(app, cookie, "Race client", "race-bot", false);
	const hook = await receiver(test);
	await post("plans", "setup");
	const mentions = await editor.subscribe(hook.url, "mention.created", {});
	const draft = await post("plans", "draft without a mention");
	await until(async () => {
		const [row] = decode(
			Schema.Array(Schema.Struct({ position: Schema.Finite })),
			await fixture.sql(`SELECT position FROM example_mcp_events WHERE id='${mentions.id}'`),
		);
		return row !== undefined && row.position >= draft.seq ? row : undefined;
	});
	for (let n = 0; n < 3; n++) await fetch(`${app.url}/api/messages?since=0`, { headers: { cookie } });
	await delay(80);
	await post("plans", "@race-bot after the idle scan");
	await eventually(() => hook.texts(mentions.id).includes("@race-bot after the idle scan"));
	expect(hook.texts(mentions.id)).toEqual(["@race-bot after the idle scan"]);
}, 120000);
