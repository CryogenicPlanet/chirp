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
const Cursor = Schema.Array(Schema.Struct({ seq: Schema.Int }));

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
	// A pong that isn't a reply to its ping, even from the right instance, doesn't count.
	await post(laptop, { topic: "agents", body: `pong ${nonce}` }, "pong-unthreaded");
	// A pong tagged roll-call, as an agent copying the ping's tags might post, is still a pong and starts nothing.
	const ponged = await post(
		laptop,
		{ topic: "agents", body: `pong ${nonce}`, tags: ["roll-call"], meta: { reply_to: ping?.seq } },
		"pong-laptop",
	);
	const verdict = await fromBoard(laptop, (message) => message.body.includes("`codex/laptop` is listening"));
	expect(verdict?.meta.reply_to).toBe(ponged.seq);
	expect((await board(laptop)).filter((message) => message.body.includes(" ping "))).toHaveLength(1);
	expect((await checks(laptop)).you).toMatchObject({ mention: "@codex/laptop", status: "listening" });

	// Another instance answering the ping is a shared mention, not a pass.
	const sharing = await post(
		build,
		{ topic: "agents", body: "codex@build: CI worker, @codex/build", tags: ["roll-call"] },
		"announce-build",
	);
	const buildPing = await fromBoard(build, (message) => message.meta.reply_to === sharing.seq);
	const buildNonce = /ping (r[ct][0-9a-z]+)/.exec(buildPing?.body ?? "")?.[1] ?? "";
	// A human quoting the nonce is ignored; another instance of the same agent answering means a shared mention.
	expect(
		(
			await app.post(
				"/api/messages",
				{ topic: "agents", body: `pong ${buildNonce}`, meta: { reply_to: buildPing?.seq } },
				cookie,
				"pong-human",
			)
		).status,
	).toBe(200);
	// The intended instance answers first and passes; a second instance answering afterwards still means shared.
	await post(build, { topic: "agents", body: `pong ${buildNonce}`, meta: { reply_to: buildPing?.seq } }, "pong-build");
	await fromBoard(build, (message) => message.body.includes("`codex/build` is listening"));
	await post(
		laptop,
		{ topic: "agents", body: `pong ${buildNonce}`, meta: { reply_to: buildPing?.seq } },
		"pong-wrong-instance",
	);
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
	// The loop handles messages in order, so once it has pinged a later announcement it has passed work-2.
	const later = await post(
		laptop,
		{ topic: "agents", body: "codex@laptop again, @codex/laptop", tags: ["roll-call"] },
		"reannounce-laptop",
	);
	await fromBoard(laptop, (message) => message.meta.reply_to === later.seq);
	expect((await board(build)).filter((message) => message.meta.reply_to === more.seq)).toEqual([]);
	expect((await checks(build)).you?.status).toBe("no_answer");

	// An agent that answers only when asked is never pinged and can't be re-tested.
	const asked = await enroll("phone");
	const quiet = await post(
		asked,
		{ topic: "agents", body: "codex@phone, checks when asked", tags: ["roll-call", "when-asked"] },
		"announce-phone",
	);
	await expect.poll(async () => (await checks(asked)).you?.status, { timeout: 15000 }).toBe("when_asked");
	expect((await board(asked)).filter((message) => message.meta.reply_to === quiet.seq)).toEqual([]);
	expect((await call(asked, "POST", "/api/rollcall/test", undefined, "phone-test")).status).toBe(409);

	// A message that fails while its table is unavailable is retried, not skipped: the cursor stays on it.
	await fixture.sql("ALTER TABLE rollcall_checks RENAME TO rollcall_checks_away");
	const retried = await post(
		laptop,
		{ topic: "agents", body: "codex@laptop, @codex/laptop", tags: ["roll-call"] },
		"announce-during-outage",
	);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await fixture.sql("ALTER TABLE rollcall_checks_away RENAME TO rollcall_checks");
	await fromBoard(laptop, (message) => message.meta.reply_to === retried.seq);

	// A replay from an older cursor, as after a restart before the cursor was saved, keeps a newer re-test.
	expect((await call(laptop, "POST", "/api/rollcall/test", undefined, "retest-laptop")).status).toBe(202);
	await expect.poll(async () => (await checks(laptop)).you?.status, { timeout: 15000 }).toBe("pending");
	const retest = (await checks(laptop)).you?.nonce ?? "";
	expect(retest).toMatch(/^rt/);
	const cursorAt = async () =>
		Schema.decodeUnknownSync(Cursor)(await fixture.sql("SELECT seq FROM rollcall_cursor WHERE id=1"))[0]?.seq ?? 0;
	const cursor = await cursorAt();
	await fixture.sql(`UPDATE rollcall_cursor SET seq=${announced.seq - 1} WHERE id=1`);
	await expect.poll(cursorAt, { timeout: 15000 }).toBeGreaterThanOrEqual(cursor);
	expect((await checks(laptop)).you).toMatchObject({ nonce: retest, status: "pending" });

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

	// An MCP connection posting through its editing grant counts as the connection it came from, not a second instance.
	const viaConnection = await enroll("mcp-direct");
	const viaGrant = await enroll("mcp-grant");
	const mcp = { mcp_client_id: "client-1" };
	const mcpAnnounced = await post(
		viaConnection,
		{ topic: "agents", body: "codex over MCP", tags: ["roll-call"], meta: mcp },
		"announce-mcp",
	);
	const mcpPing = await fromBoard(viaConnection, (message) => message.meta.reply_to === mcpAnnounced.seq);
	expect(mcpPing?.body).toMatch(/^@codex ping rc/);
	const mcpNonce = /ping (r[ct][0-9a-z]+)/.exec(mcpPing?.body ?? "")?.[1] ?? "";
	await post(
		viaGrant,
		{ topic: "agents", body: `pong ${mcpNonce}`, meta: { ...mcp, reply_to: mcpPing?.seq } },
		"pong-mcp",
	);
	await fromBoard(viaGrant, (message) => message.body.includes("`codex` is listening"));
	expect((await checks(viaGrant)).items.find((check) => check.nonce === mcpNonce)?.instance).toBe(
		"extension:mcp:client-1",
	);

	// A new instance announcing a mention another instance held, as after re-enrolling, replaces that instance's row.
	await post(
		unannounced,
		{ topic: "agents", body: "codex@build again, @codex/build", tags: ["roll-call"] },
		"announce-fresh",
	);
	await expect.poll(async () => (await checks(unannounced)).you?.status, { timeout: 15000 }).toBe("pending");
	expect((await checks(build)).you).toBeNull();

	// A ping that keeps failing, here because its topic is archived, backs off instead of spinning the loop.
	const since = await cursorAt();
	await fixture.sql("UPDATE topics SET archived_at=1 WHERE path='agents'");
	expect((await call(unannounced, "POST", "/api/rollcall/test", undefined, "retest-archived")).status).toBe(202);
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const Events = Schema.Struct({ items: Schema.Array(Schema.Struct({ type: Schema.String })) });
	const events = Schema.decodeUnknownSync(Events)(
		await (await call(laptop, "GET", `/api/events?since=${since}&limit=200`)).json(),
	);
	const failed = events.items.filter((event) => event.type === "rollcall.failed").length;
	expect(failed).toBeGreaterThan(0);
	expect(failed).toBeLessThan(6);
}, 120000);

it("posts as rollcall-board on a board whose owner took the name rollcall", async (test) => {
	const fixture = await conversation(test);
	const first = await fixture.launch();
	await first.setup("rollcall");
	await first.ready(await first.login());
	await first.stop();
	// Boot names the owner to the app from the launch after setup.
	const app = await fixture.launch();
	const cookie = await app.login();
	await app.ready(cookie);
	const enrolled = await (await app.post("/auth/enroll", { name: "codex", kind: "codex", host: "laptop" })).json();
	const scopes = ["read", "write"];
	const proof = await app.assertion({ id: enrolled.id, decision: "approve", scopes, long_lived: false });
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrolled.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: proof },
				body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
			})
		).status,
	).toBe(200);
	const token = String(
		(await (await app.post(`/auth/enroll/${enrolled.id}`, { device_secret: enrolled.device_secret })).json()).access,
	);
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	const posted = await fetch(`${app.url}/api/messages`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": "announce" },
		body: JSON.stringify({ topic: "agents", body: "codex@laptop, @codex/laptop", tags: ["roll-call"] }),
	});
	expect(posted.status).toBe(200);
	const announced = Schema.decodeUnknownSync(Item)(await posted.json());
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(Page)(
					await (await fetch(`${app.url}/api/messages?topic=agents&newest=1&limit=50&mark=0`, { headers })).json(),
				).items.find((message) => message.meta.reply_to === announced.seq)?.agent,
			{ timeout: 15000 },
		)
		.toBe("rollcall-board");
}, 60000);
