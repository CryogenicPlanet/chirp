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
