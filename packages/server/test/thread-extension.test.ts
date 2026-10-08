import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const Posted = Schema.Struct({ seq: Schema.Int });
const Thread = Schema.Struct({
	root: Schema.Int,
	target: Schema.Int,
	count: Schema.Int,
	topics: Schema.Array(Schema.String),
	items: Schema.Array(Schema.Struct({ seq: Schema.Int, parent: Schema.NullOr(Schema.Int), depth: Schema.Int })),
});

it("follows reply_to and re edges to the root and returns the whole thread across topics", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const example = await readFile(join(import.meta.dirname, "../../../examples/extensions/thread.ts"), "utf8");
	await writeFile(
		join(seed, "ext/thread.ts"),
		example.replace("../../packages/server/src/kernel/extension-api.ts", "../kernel/extension-api.ts"),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, meta: Readonly<Record<string, unknown>>, key: string) => {
		const response = await app.post("/api/messages", { topic, body: key, meta }, cookie, key);
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(Posted)(await response.json()).seq;
	};
	const root = await post("plans", {}, "root");
	const reply = await post("plans", { reply_to: root }, "reply");
	// The older convention, and a string sequence, still count as edges.
	const nested = await post("plans/followup", { re: String(reply) }, "nested");
	await post("plans", {}, "unrelated");
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	const thread = Schema.decodeUnknownSync(Thread)(await (await get(`/api/thread/${nested}`)).json());
	expect(thread).toMatchObject({ root, target: nested, count: 3, topics: ["plans", "plans/followup"] });
	expect(thread.items).toEqual([
		{ seq: root, parent: null, depth: 0 },
		{ seq: reply, parent: root, depth: 1 },
		{ seq: nested, parent: reply, depth: 2 },
	]);
	expect((await get("/api/thread/0")).status).toBe(400);
	expect((await get(`/api/thread/${nested + 1000}`)).status).toBe(404);
}, 30000);

it("rejects incomplete parent chains when since excludes ancestors", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const example = await readFile(join(import.meta.dirname, "../../../examples/extensions/thread.ts"), "utf8");
	await writeFile(
		join(seed, "ext/thread.ts"),
		example.replace("../../packages/server/src/kernel/extension-api.ts", "../kernel/extension-api.ts"),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, meta: Readonly<Record<string, unknown>>, key: string) => {
		const response = await app.post("/api/messages", { topic, body: key, meta }, cookie, key);
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(Posted)(await response.json()).seq;
	};
	const msg1 = await post("test", {}, "msg1");
	const msg2 = await post("test", { reply_to: msg1 }, "msg2");
	const msg3 = await post("test", { reply_to: msg2 }, "msg3");
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	// Querying msg3 with since=msg1 excludes msg1 (since is exclusive), so the chain is incomplete.
	// The endpoint should not claim msg1 as the root when it wasn't scanned.
	const thread = Schema.decodeUnknownSync(Thread)(await (await get(`/api/thread/${msg3}?since=${msg1}`)).json());
	// The root should be msg2 (the earliest scanned ancestor), not msg1 (unscanned)
	expect(thread.root).toBe(msg2);
	expect(thread.items).toEqual([
		{ seq: msg2, parent: null, depth: 0 },
		{ seq: msg3, parent: msg2, depth: 1 },
	]);
}, 30000);

it("uses a stable root for cycle members", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const example = await readFile(join(import.meta.dirname, "../../../examples/extensions/thread.ts"), "utf8");
	await writeFile(
		join(seed, "ext/thread.ts"),
		example.replace("../../packages/server/src/kernel/extension-api.ts", "../kernel/extension-api.ts"),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const post = async (topic: string, meta: Readonly<Record<string, unknown>>, key: string) => {
		const response = await app.post("/api/messages", { topic, body: key, meta }, cookie, key);
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(Posted)(await response.json()).seq;
	};
	const msgA = await post("test", {}, "msgA");
	const msgB = await post("test", {}, "msgB");
	// Create a cycle: A replies to B, B replies to A
	const patch = (seq: number, meta: Readonly<Record<string, unknown>>, key: string) =>
		fetch(`${app.url}/api/messages/${seq}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", origin: "https://comms.test", cookie, "idempotency-key": key },
			body: JSON.stringify({ meta }),
		});
	await patch(msgA, { reply_to: msgB }, "update-A");
	await patch(msgB, { reply_to: msgA }, "update-B");
	const get = (path: string) => fetch(`${app.url}${path}`, { headers: { cookie } });
	const threadA = Schema.decodeUnknownSync(Thread)(await (await get(`/api/thread/${msgA}`)).json());
	const threadB = Schema.decodeUnknownSync(Thread)(await (await get(`/api/thread/${msgB}`)).json());
	// Both queries should return the same root (the minimum sequence in the cycle)
	const expectedRoot = Math.min(msgA, msgB);
	expect(threadA.root).toBe(expectedRoot);
	expect(threadB.root).toBe(expectedRoot);
	// Both should contain both messages
	expect(threadA.count).toBe(2);
	expect(threadB.count).toBe(2);
	// The root should appear in items
	expect(threadA.items.some((item) => item.seq === expectedRoot)).toBe(true);
	expect(threadB.items.some((item) => item.seq === expectedRoot)).toBe(true);
}, 30000);
