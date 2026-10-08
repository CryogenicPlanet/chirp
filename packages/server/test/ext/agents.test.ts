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
});

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
