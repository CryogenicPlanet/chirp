import { assertionHeader, baseVersionHeader } from "@comms/protocol/headers";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";
import { sourcePut } from "./fixtures/source-put.ts";

const Relay = Schema.Struct({
	status: Schema.Int,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.String,
});
const Approved = Schema.Struct({
	status: Schema.Literal("approved"),
	family: Schema.String,
	agent: Schema.String,
	scopes: Schema.Array(Schema.String),
	expires_at: Schema.Int,
});
const Status = Schema.Struct({
	child: Schema.Struct({ state: Schema.String, generation: Schema.NullOr(Schema.Int) }),
	traffic: Schema.Struct({ frozen: Schema.Boolean, admitted: Schema.Int }),
});
const Message = Schema.Struct({
	id: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	body: Schema.String,
});
const Lock = Schema.Struct({
	lock: Schema.NullOr(Schema.Struct({ holder_family: Schema.String, cutover_in_flight: Schema.Int })),
});
const json = (text: string) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(text);

/** A seed with a test extension that drives ctx.agentGrants the way MCP would. */
async function installed(test: TestContext) {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await mkdir(join(seed, "ext/grant-probe"), { recursive: true });
	const extension = await readFile(join(import.meta.dirname, "fixtures/grant-probe/index.ts"), "utf8");
	await writeFile(
		join(seed, "ext/grant-probe/index.ts"),
		extension.replace("../../../src/kernel/extension-api.ts", "../../kernel/extension-api.ts"),
	);
	await writeFile(join(seed, "ext/grant-probe/package.json"), "{}\n");
	// The freeze test holds an admitted upload open longer than the default body deadline.
	const bodySource = await readFile(join(seed, "request-schema.ts"), "utf8");
	await writeFile(
		join(seed, "request-schema.ts"),
		bodySource.replace('Effect.timeout("5 seconds")', 'Effect.timeout("30 seconds")'),
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const probe = async (path: string, body: unknown) => {
		const response = await app.post(path, body, cookie);
		return { status: response.status, body: json(await response.text()) };
	};
	const status = async () =>
		Schema.decodeUnknownSync(Status)(await (await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).json());
	/** The extension requests, the human approves with a passkey, the extension collects: no secret changes hands. */
	const grant = async (scopes: readonly string[]) => {
		const requested = await probe("/api/grant-probe/request", { agent: "dot", label: "probe", scopes });
		expect(requested.status).toBe(200);
		const { id, approve_url } = Schema.decodeUnknownSync(
			Schema.Struct({ id: Schema.String, approve_url: Schema.String }),
		)(requested.body);
		expect(approve_url).toBe(`https://comms.test/approve/${id}`);
		expect((await probe("/api/grant-probe/collect", { id })).body).toMatchObject({ status: "pending" });
		const params = { id, decision: "approve" as const, scopes, long_lived: false };
		const approval = await fetch(`${app.url}/_boot/enroll/${id}/approve`, {
			method: "POST",
			headers: {
				origin: "https://comms.test",
				"content-type": "application/json",
				[assertionHeader]: await app.assertion(params),
			},
			body: JSON.stringify({ decision: "approve", scopes, long_lived: false }),
		});
		expect(approval.status).toBe(200);
		const collected = await probe("/api/grant-probe/collect", { id });
		expect(
			Object.keys(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(collected.body)).sort(),
		).toEqual(["agent", "expires_at", "family", "label", "scopes", "status"]);
		return Schema.decodeUnknownSync(Approved)(collected.body).family;
	};
	const via = async (
		family: string,
		path: string,
		init: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> } = {},
	) => {
		const response = await probe("/api/grant-probe/fetch", { family, path, ...init });
		expect(response.status, JSON.stringify(response.body)).toBe(200);
		return Schema.decodeUnknownSync(Relay)(response.body);
	};
	return { fixture, app, cookie, probe, status, grant, via };
}

it("lets an extension act as a human-approved agent through boot, through a detached reload and revocation", async (test) => {
	const { fixture, app, cookie, probe, status, grant, via } = await installed(test);
	const family = await grant(["read", "write", "fs"]);

	// Messages are written as the agent, with the family as instance, whoever the outer caller was.
	const posted = await via(family, "/api/messages", {
		method: "POST",
		body: JSON.stringify({ topic: "grants", body: "from dot" }),
		headers: { "idempotency-key": "grant-post" },
	});
	expect(posted.status).toBe(200);
	const message = Schema.decodeUnknownSync(Message)(json(posted.body));
	expect(message).toMatchObject({ agent: "dot", instance: family, body: "from dot" });
	const patched = await via(family, `/api/messages/${message.id}`, {
		method: "PATCH",
		body: JSON.stringify({ body: "edited by dot" }),
	});
	expect(patched.status).toBe(200);
	expect(json(patched.body)).toMatchObject({ agent: "dot", instance: family, body: "edited by dot" });
	// Credentials and chirp headers the caller supplies are dropped before boot sees the call.
	const stripped = await via(family, "/api/messages?topic=grants&limit=5", {
		headers: {
			authorization: `Bearer ${"a".repeat(43)}`,
			cookie,
			"x-chirp-agent": "rahul",
			"x-chirp-grant": "f_other",
			"x-boot-secret": "0".repeat(64),
			"x-forwarded-for": "10.0.0.1",
			forwarded: "for=10.0.0.1",
		},
	});
	expect(stripped.status).toBe(200);

	// Pages publish as the agent with fs scope.
	const page = await via(family, "/api/fs/pages/grants/notes.md?baseVersion=null", {
		method: "PUT",
		body: "# Notes from dot\n",
	});
	expect(page.status, page.body).toBe(200);
	expect(json(page.body)).toMatchObject({ published: true });
	const history = Schema.decodeUnknownSync(
		Schema.Struct({ items: Schema.Array(Schema.Struct({ agent: Schema.String })) }),
	)(await (await fetch(`${app.url}/api/fs/pages/grants/notes.md?history`, { headers: { cookie } })).json());
	expect(history.items[0]?.agent).toBe("dot");

	// The kernel refuses calls that could deadlock or escape before they reach boot.
	expect((await probe("/api/grant-probe/refusals", { id: family })).body).toEqual({
		mutate: "input_invalid",
		read: "input_invalid",
		protocolRelative: "input_invalid",
		spaced: "input_invalid",
		backslash: "input_invalid",
		method: "input_invalid",
	});
	const readOnly = await fetch(
		`${app.url}/api/grant-probe/fetch?family=${family}&path=${encodeURIComponent("/api/messages")}&method=POST`,
		{ headers: { cookie } },
	);
	expect(await readOnly.json()).toMatchObject({ error: "scope_required" });

	// Lock, stage without reloading, then reload: boot answers at once and finishes after this request drains.
	expect(json((await via(family, "/api/lock", { method: "POST", body: "{}" })).body)).toMatchObject({
		lock: { holder_family: family, agent: "dot" },
	});
	const current = await via(family, "/api/fs/app/server.ts");
	const base = current.headers[baseVersionHeader];
	if (!base) throw new Error("Missing base version");
	const staged = await via(family, `/api/fs/app/server.ts?reload=0&baseVersion=${base}`, {
		method: "PUT",
		body: `${current.body}\n// staged through an extension grant\n`,
	});
	expect(staged.status, staged.body).toBe(200);
	const before = (await status()).child.generation ?? 0;
	const started = performance.now();
	const reload = await via(family, "/api/reload", { method: "POST", body: "{}" });
	expect(reload.status, reload.body).toBe(202);
	expect(json(reload.body)).toMatchObject({ status: "reloading", lock: { holder_family: family } });
	expect(performance.now() - started).toBeLessThan(5000);
	// The generation that sent the reload is the one it retires; boot owns the work until the new one is live.
	await expect
		.poll(async () => (await status()).child, { timeout: 60000, interval: 250 })
		.toMatchObject({ state: "live", generation: before + 1 });
	expect(await (await fetch(`${app.url}/api/fs/app/server.ts`, { headers: { cookie } })).text()).toContain(
		"// staged through an extension grant",
	);
	await expect
		.poll(async () =>
			Schema.decodeUnknownSync(Lock)(await (await fetch(`${app.url}/api/lock`, { headers: { cookie } })).json()),
		)
		.toEqual({ lock: expect.objectContaining({ holder_family: family, cutover_in_flight: 0 }) });
	// The new generation reaches boot with its own secret; the grant is unchanged.
	expect((await via(family, "/api/messages?topic=grants&limit=1")).status).toBe(200);

	// A failed detached reload keeps the repair lock and the serving generation.
	const live = (await status()).child.generation ?? 0;
	const next = await via(family, "/api/fs/app/server.ts");
	const nextBase = next.headers[baseVersionHeader];
	if (!nextBase) throw new Error("Missing base version");
	expect(
		(
			await via(family, `/api/fs/app/server.ts?reload=0&baseVersion=${nextBase}`, {
				method: "PUT",
				body: "export const = ;\n",
			})
		).status,
	).toBe(200);
	expect((await via(family, "/api/reload", { method: "POST", body: "{}" })).status).toBe(202);
	const Generations = Schema.Struct({
		items: Schema.Array(Schema.Struct({ n: Schema.Int, error: Schema.NullOr(Schema.String) })),
	});
	await expect
		.poll(
			async () =>
				Schema.decodeUnknownSync(Generations)(
					await (await fetch(`${app.url}/api/generations`, { headers: { cookie } })).json(),
				).items.some((item) => item.n > live && item.error !== null),
			{ timeout: 60000, interval: 250 },
		)
		.toBe(true);
	await expect
		.poll(async () =>
			Schema.decodeUnknownSync(Lock)(await (await fetch(`${app.url}/api/lock`, { headers: { cookie } })).json()),
		)
		.toEqual({ lock: expect.objectContaining({ holder_family: family, cutover_in_flight: 0 }) });
	expect((await status()).child).toMatchObject({ state: "live", generation: live });

	// The account lists the family as held by the extension; revocation ends it and releases the lock.
	const families = Schema.decodeUnknownSync(
		Schema.Struct({
			items: Schema.Array(Schema.Struct({ family: Schema.String, held_by: Schema.NullOr(Schema.String) })),
		}),
	)(await (await fetch(`${app.url}/_boot/tokens`, { headers: { cookie } })).json());
	expect(families.items.find((item) => item.family === family)?.held_by).toBe("grant-probe");
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
	const refused = await via(family, "/api/messages?topic=grants&limit=1");
	expect(refused.status).toBe(401);
	expect(json(refused.body)).toMatchObject({ error: { code: "grant_invalid" } });
	expect(await (await fetch(`${app.url}/api/lock`, { headers: { cookie } })).json()).toEqual({ lock: null });
	expect(await fixture.sql(`SELECT kind FROM tokens WHERE family='${family}'`, "boot.db")).toEqual([
		{ kind: "access" },
	]);
}, 240000);

it("refuses grant calls with board_busy during a reload freeze while ordinary requests still queue", async (test) => {
	const { app, cookie, status, grant, via } = await installed(test);
	const family = await grant(["read"]);
	const read = `/api/grant-probe/fetch?family=${family}&path=${encodeURIComponent("/api/messages?limit=1")}`;
	expect((await (await fetch(`${app.url}${read}`, { headers: { cookie } })).json()).status).toBe(200);

	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const source = await (await fetch(`${app.url}/api/fs/app/server.ts`, { headers: { cookie } })).text();
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/server.ts?reload=0`, {
				method: "PUT",
				headers: { cookie, origin: "https://comms.test" },
				body: `${source}\n// reload under a grant freeze\n`,
			})
		).status,
	).toBe(200);
	// An admitted upload keeps the cutover frozen while it waits to drain.
	const upload = request(`${app.url}/api/messages`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
	});
	test.onTestFinished(() => {
		upload.destroy();
	});
	const uploaded = new Promise<number>((resolve, reject) => {
		upload.on("error", reject);
		upload.on("response", (response) => {
			response.resume();
			response.on("end", () => resolve(response.statusCode ?? 0));
		});
	});
	upload.write('{"topic":"freeze","body":"');
	await expect.poll(async () => (await status()).traffic.admitted).toBe(1);
	const reload = app.post("/api/reload", {}, cookie);
	await expect.poll(async () => (await status()).traffic, { timeout: 10000 }).toMatchObject({ frozen: true });

	// A grant never queues behind the freeze its enclosing request could be holding.
	const started = performance.now();
	const busy = Schema.decodeUnknownSync(Relay)(
		await (await fetch(`${app.url}${read}`, { headers: { cookie } })).json(),
	);
	expect(performance.now() - started).toBeLessThan(2000);
	expect(busy.status).toBe(503);
	expect(json(busy.body)).toMatchObject({ error: { code: "board_busy", retriable: true } });
	// An ordinary mutation still waits for the freeze to end, as before.
	const queued = app.post("/api/messages", { topic: "freeze", body: "queued" }, cookie);
	let settled = false;
	void queued.then(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(settled).toBe(false);
	upload.end('held"}');
	expect(await uploaded).toBe(200);
	expect(await (await reload).json()).toMatchObject({ status: "live" });
	expect((await queued).status).toBe(200);
	expect((await via(family, "/api/messages?limit=1")).status).toBe(200);
}, 120000);
