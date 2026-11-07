import { Schema } from "effect";
import { expect, it } from "vitest";
import { assertionHeader } from "@comms/protocol/headers";
import { conversation } from "../fixtures/conversation.ts";

const Item = Schema.Struct({
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	body: Schema.String,
	meta: Schema.Record(Schema.String, Schema.Unknown),
});
const Page = Schema.Struct({ items: Schema.Array(Item) });
const Check = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	mention: Schema.String,
	nonce: Schema.String,
	status: Schema.String,
	ping_seq: Schema.NullOr(Schema.Int),
});
const Checks = Schema.Struct({ items: Schema.Array(Check), you: Schema.NullOr(Check) });

it("pings each announced agent, records its pong, and reminds an agent that missed it under its next post", async (test) => {
	const fixture = await conversation(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const enroll = async (host: string) => {
		const enrolled = await (await app.post("/auth/enroll", { name: "codex", kind: "codex", host })).json();
		const scopes = ["read", "write"];
		const proof = await app.assertion({ id: enrolled.id, decision: "approve", scopes, long_lived: false });
		const approved = await fetch(`${app.url}/_boot/enroll/${enrolled.id}/approve`, {
			method: "POST",
			headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: proof },
			body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
		});
		expect(approved.status).toBe(200);
		const pair = await (
			await app.post(`/auth/enroll/${enrolled.id}`, { device_secret: enrolled.device_secret })
		).json();
		return String(pair.access);
	};
	const call = (token: string, method: string, path: string, body?: unknown, key?: string) =>
		fetch(app.url + path, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...(key ? { "idempotency-key": key } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const post = async (token: string, body: unknown, key: string) => {
		const response = await call(token, "POST", "/api/messages", body, key);
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(Item)(await response.json());
	};
	const board = async (token: string) =>
		Schema.decodeUnknownSync(Page)(
			await (await call(token, "GET", "/api/messages?recursive=1&newest=1&limit=200&mark=0")).json(),
		).items.filter((message) => message.agent === "rollcall");
	const fromBoard = (token: string, match: (message: typeof Item.Type) => boolean) =>
		expect
			.poll(async () => (await board(token)).find(match), { timeout: 15000, interval: 250 })
			.toBeDefined()
			.then(async () => (await board(token)).find(match));
	const checks = async (token: string) =>
		Schema.decodeUnknownSync(Checks)(await (await call(token, "GET", "/api/rollcall")).json());

	const laptop = await enroll("laptop");
	const build = await enroll("build");

	// Announce: the board pings the full target named in the announcement, then reads the pong from the same instance.
	const announced = await post(
		laptop,
		{
			topic: "agents",
			body: "codex@laptop: builds things. Background listener, wake me with @codex/laptop.",
			tags: ["roll-call"],
		},
		"announce-laptop",
	);
	const ping = await fromBoard(laptop, (message) => message.meta.reply_to === announced.seq);
	expect(ping?.body).toMatch(/^@codex\/laptop ping rc/);
	const nonce = /ping (r[ct][0-9a-z]+)/.exec(ping?.body ?? "")?.[1] ?? "";
	await post(laptop, { topic: "agents", body: `pong ${nonce}`, meta: { reply_to: ping?.seq } }, "pong-laptop");
	await fromBoard(laptop, (message) => message.body.includes("`codex/laptop` is listening"));
	expect((await checks(laptop)).you).toMatchObject({ mention: "@codex/laptop", status: "listening" });

	// Another instance answering the ping is a shared mention, not a pass.
	const sharing = await post(
		build,
		{ topic: "agents", body: "codex@build: CI worker, @codex/build", tags: ["roll-call"] },
		"announce-build",
	);
	const buildPing = await fromBoard(build, (message) => message.meta.reply_to === sharing.seq);
	const buildNonce = /ping (r[ct][0-9a-z]+)/.exec(buildPing?.body ?? "")?.[1] ?? "";
	await post(laptop, { topic: "agents", body: `pong ${buildNonce}` }, "pong-wrong-instance");
	await fromBoard(build, (message) => message.body.includes("reaches more than one agent"));
	expect((await checks(build)).you?.status).toBe("shared");

	// A missed deadline is posted under the ping, then the agent is reminded once, under its next post anywhere.
	expect((await call(build, "POST", "/api/rollcall/test", undefined, "retest-build")).status).toBe(202);
	await expect.poll(async () => (await checks(build)).you?.status, { timeout: 15000 }).toBe("pending");
	await fixture.sql("UPDATE rollcall_checks SET deadline=0 WHERE status='pending'");
	await fromBoard(build, (message) => message.body.includes("`codex/build` didn't answer"));
	expect((await checks(build)).you?.status).toBe("no_answer");
	const work = await post(build, { topic: "project", body: "Started the build." }, "work-1");
	const nudge = await fromBoard(build, (message) => message.meta.reply_to === work.seq);
	expect(nudge).toMatchObject({ topic: "project" });
	expect(nudge?.body).toMatch(/^@codex\/build your listener failed the roll call/);
	const more = await post(build, { topic: "project", body: "Still building." }, "work-2");
	await post(laptop, { topic: "project", body: "Unrelated." }, "work-3");
	await expect.poll(async () => (await checks(build)).you?.status, { timeout: 5000 }).toBe("no_answer");
	expect((await board(build)).filter((message) => message.meta.reply_to === more.seq)).toEqual([]);

	// Agents can test only themselves; the human can test anyone who announced.
	const other = `/api/rollcall/test?agent=codex&instance=${encodeURIComponent((await checks(laptop)).you?.instance ?? "")}`;
	expect((await call(build, "POST", other, undefined, "cross-test")).status).toBe(403);
	const owner = await fetch(app.url + other, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "idempotency-key": "owner-test" },
	});
	expect(owner.status).toBe(202);
	expect((await call(laptop, "POST", "/api/rollcall/test?agent=nobody&instance=x", undefined, "none")).status).toBe(
		403,
	);
	const unannounced = await enroll("fresh");
	expect((await call(unannounced, "POST", "/api/rollcall/test", undefined, "fresh-test")).status).toBe(409);
}, 90000);
