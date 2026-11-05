import { assertionHeader } from "@comms/protocol/headers";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { conversation } from "../fixtures/conversation.ts";

const day = 86_400_000;
const Posted = Schema.Struct({ id: Schema.String, seq: Schema.Int });
const Activity = Schema.Struct({
	as_of: Schema.Int,
	items: Schema.Array(
		Schema.Struct({
			agent: Schema.String,
			posts: Schema.Int,
			posts_24h: Schema.Int,
			posts_7d: Schema.Int,
			last_post_at: Schema.Int,
			mcp: Schema.Boolean,
		}),
	),
	reads: Schema.Array(
		Schema.Struct({ instance: Schema.String, read: Schema.Int, unread: Schema.Int, topics: Schema.Int }),
	),
});
const Pair = Schema.Struct({ access: Schema.String });
const Me = Schema.Struct({ instance: Schema.String });
const Enrollment = Schema.Struct({ id: Schema.String, device_secret: Schema.String });
const Messages = Schema.Struct({ items: Schema.Array(Schema.Struct({ agent: Schema.String })) });

it("counts each author's undeleted posts over the last day, the last week and all time", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	expect((await fetch(`${app.url}/api/agents/activity`)).status).toBe(401);
	const posted = [];
	for (const body of ["today", "earlier this week", "deleted"]) {
		const response = await app.post("/api/messages", { topic: "activity", body }, cookie, `activity-${body}`);
		expect(response.status).toBe(200);
		posted.push(Schema.decodeUnknownSync(Posted)(await response.json()));
	}
	const [, earlier, deleted] = posted;
	if (!earlier || !deleted) throw new Error("posts are missing");
	const removal = await fetch(`${app.url}/api/messages/${deleted.id}`, {
		method: "DELETE",
		headers: { cookie, origin: "https://comms.test", "idempotency-key": "activity-delete" },
	});
	expect(removal.status).toBe(200);
	await fixture.sql(`UPDATE messages SET created_at=created_at-${3 * day} WHERE seq=${earlier.seq}`);
	const activity = Schema.decodeUnknownSync(Activity)(
		await (await fetch(`${app.url}/api/agents/activity`, { headers: { cookie } })).json(),
	);
	const rahul = activity.items.find((item) => item.agent === "rahul");
	expect(rahul).toMatchObject({ posts: 2, posts_24h: 1, posts_7d: 2, mcp: false });
	expect(activity.as_of - (rahul?.last_post_at ?? 0)).toBeLessThan(day);
	const order = activity.items.map((item) => item.last_post_at);
	expect(order).toEqual(order.toSorted((a, b) => b - a));
}, 30000);

it("counts, per session, the other authors' messages its read marks cover", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const enrollment = Schema.decodeUnknownSync(Enrollment)(
		await (await app.post("/auth/enroll", { name: "reader", kind: "codex", host: "laptop" })).json(),
	);
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read", "write"], long_lived: false };
	const decision = await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
		method: "POST",
		headers: {
			origin: "https://comms.test",
			"content-type": "application/json",
			[assertionHeader]: await app.assertion(params),
		},
		body: JSON.stringify({ decision: "approve", scopes: params.scopes, long_lived: false }),
	});
	expect(decision.status).toBe(200);
	const { access } = Schema.decodeUnknownSync(Pair)(
		await (await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })).json(),
	);
	const reader = { authorization: `Bearer ${access}`, "content-type": "application/json" };
	const { instance } = Schema.decodeUnknownSync(Me)(
		await (await fetch(`${app.url}/api/me`, { headers: reader })).json(),
	);
	for (const [topic, body] of [
		["plans/home", "first"],
		["plans/home", "second"],
		["taxes", "elsewhere"],
	] as const)
		expect((await app.post("/api/messages", { topic, body }, cookie, `reads-${body}`)).status).toBe(200);
	const own = await fetch(`${app.url}/api/messages`, {
		method: "POST",
		headers: { ...reader, "idempotency-key": "reads-own" },
		body: JSON.stringify({ topic: "taxes", body: "my own note" }),
	});
	expect(own.status).toBe(200);
	// A topic view marks what it showed; a newest-only read marks nothing.
	expect((await fetch(`${app.url}/api/topics/plans/home`, { headers: reader })).status).toBe(200);
	expect((await fetch(`${app.url}/api/messages?topic=taxes&newest=1`, { headers: reader })).status).toBe(200);
	const everything = Schema.decodeUnknownSync(Messages)(
		await (await fetch(`${app.url}/api/messages?since=0&limit=100&mark=0`, { headers: reader })).json(),
	);
	// The board's own onboarding posts count as unread too; only the reader's post does not.
	const others = everything.items.filter((message) => message.agent !== "reader").length;
	const activity = Schema.decodeUnknownSync(Activity)(
		await (await fetch(`${app.url}/api/agents/activity`, { headers: { cookie } })).json(),
	);
	expect(activity.reads.find((item) => item.instance === instance)).toEqual({
		instance,
		read: 2,
		unread: others - 2,
		topics: 1,
	});
}, 30000);
