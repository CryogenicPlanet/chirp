import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

type Seen = { instance: string; agent: string; label?: string; at: number };
type Item = { seq: number; instance: string; agent: string; seen_by?: Seen[] };

it("records who each view returned a message to, honoring mark=0 and leaving out the author and viewer", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const reader = await app.login(),
		author = await app.login();
	await app.ready(reader);
	const post = async (topic: string, body: string, cookie = author): Promise<Item> => {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		return response.json();
	};
	const get = async (path: string, cookie = reader) => {
		const response = await fetch(`${app.url}${path}`, { headers: { cookie } });
		expect(response.status, await response.clone().text()).toBe(200);
		return response.json();
	};
	const seen = () => fixture.sql("SELECT seq,instance FROM seen ORDER BY seq,instance");
	const marks = (instance: string) => fixture.sql(`SELECT topic,seq FROM reads WHERE instance='${instance}'`);
	// What the author's peek shows for each message in the topic.
	const authorView = async (): Promise<Map<number, Seen[] | undefined>> =>
		new Map(
			(await get("/api/topics/work?mark=0&receipts=1", author)).messages.map((item: Item) => [item.seq, item.seen_by]),
		);
	// The reader posts once, elsewhere, so the test knows its instance and agent.
	const me = await post("introductions", "reader", reader);
	const earlier = await post("work", "earlier context");
	const mention = await post("work", "over to @codex.");
	expect(mention.instance).not.toBe(me.instance);
	// Boot labels a signed-in human's session `human`; an agent's carries its token label.
	const receipt = { instance: me.instance, agent: me.agent, label: "human", at: expect.any(Number) };

	// Peeks and the author's own reads record nothing.
	await get("/api/topics/work?mark=0");
	await get("/api/messages?since=0&topic=work&mark=0");
	await get("/api/messages?newest=1&limit=5&mark=0");
	await get("/api/topics/work", author);
	expect(await seen()).toEqual([]);

	// A mention listener is shown only the mention: neither the earlier message nor a read mark is recorded.
	const listened = await get(`/api/messages?since=${me.seq}&mentions=@codex`);
	expect(listened.items).toEqual([mention]);
	expect(await marks(me.instance)).toEqual([]);
	const afterMention = await authorView();
	expect(afterMention.get(earlier.seq)).toBeUndefined();
	expect(afterMention.get(mention.seq)).toEqual([receipt]);

	// A topic view marks the topic and records every returned message, keeping the first time each was seen.
	const viewed = await get("/api/topics/work?receipts=1");
	expect(viewed.messages.map((item: Item) => item.seen_by)).toEqual([undefined, undefined]);
	expect(await marks(me.instance)).toEqual([{ topic: "work", seq: mention.seq }]);
	const afterView = await authorView();
	expect(afterView.get(earlier.seq)).toEqual([receipt]);
	expect(afterView.get(mention.seq)).toEqual(afterMention.get(mention.seq));

	// Newest reads record what they return without moving the mark, and the reader then sees the author's receipt.
	const later = await post("work", "after the view");
	await get("/api/messages?newest=1&limit=1&topic=work");
	expect(await marks(me.instance)).toEqual([{ topic: "work", seq: mention.seq }]);
	expect((await authorView()).get(later.seq)).toEqual([receipt]);
	expect(await seen()).toEqual(
		[earlier, mention, later].map((message) => ({ seq: message.seq, instance: me.instance })),
	);
	await get("/api/topics/introductions", author);
	const mine = await get("/api/messages?since=0&topic=introductions&mark=0&receipts=1");
	expect(mine.items[0].seen_by).toEqual([
		{ instance: mention.instance, agent: mention.agent, label: "human", at: expect.any(Number) },
	]);
	// Without receipts=1 a read carries no seen_by, so agents pay for receipts only when they ask.
	expect((await get("/api/messages?since=0&topic=introductions&mark=0")).items[0].seen_by).toBeUndefined();

	// The poll route returns the topic's receipts from a sequence on, leaves the caller out, and records nothing.
	const before = await seen();
	const polled = await get(`/api/seen?topic=work&from=${mention.seq}`, author);
	expect(polled).toEqual({
		truncated: false,
		items: [mention, later].map((message) => ({ seq: message.seq, ...receipt })),
	});
	expect((await get("/api/seen?topic=work")).items).toEqual([]);
	expect(await seen()).toEqual(before);
	const refused = await fetch(`${app.url}/api/seen?topic=..`, { headers: { cookie: reader } });
	expect(refused.status).toBe(400);
}, 30000);
