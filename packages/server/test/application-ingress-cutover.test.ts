import { Schema } from "effect";
import { expect, it } from "vitest";
import { ingressCutover } from "./fixtures/application-ingress-cutover.ts";
import { sourcePut } from "./fixtures/source-put.ts";

it("rechecks a queued anonymous write against the new generation's private route", async (test) => {
	const fixture = await ingressCutover(test);
	const app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const headers = { cookie, origin: "https://comms.test" };
	const status = async () =>
		Schema.decodeUnknownSync(
			Schema.Struct({
				child: Schema.Struct({ pid: Schema.Int, generation: Schema.Int }),
				traffic: Schema.Struct({ frozen: Schema.Boolean, queued: Schema.Int }),
			}),
		)(await (await fetch(`${app.url}/_boot/status`, { headers })).json());
	const old = (await status()).child;
	const write = (body: string) =>
		fetch(`${app.url}/managed-cutover`, { method: "POST", body, headers: { "idempotency-key": body } });
	const baseline = await write("before-cutover");
	expect(baseline.status).toBe(200);
	expect(await baseline.json()).toMatchObject({ body: "before-cutover", agent: "system" });
	expect((await app.post("/api/lock", {}, cookie)).status).toBe(200);
	const replacement = fixture.extension.replace('access:"application-managed"', 'scope:"write"');
	expect(replacement).not.toBe(fixture.extension);
	expect(
		(
			await sourcePut(`${app.url}/api/fs/app/ext/managed-cutover.ts?reload=0`, {
				method: "PUT",
				headers,
				body: replacement,
			})
		).status,
	).toBe(200);
	const reload = app.post("/api/reload", {}, cookie);
	void reload.catch(() => undefined);
	let pending: Promise<Response> | undefined;
	let candidate = 0;
	try {
		candidate = await fixture.wait();
		expect(candidate).not.toBe(old.pid);
		expect((await status()).traffic.frozen).toBe(true);
		pending = write("queued-must-not-write");
		void pending.catch(() => undefined);
		// Positive queue evidence ensures the request was admitted before changing generations.
		await expect.poll(async () => (await status()).traffic.queued).toBe(1);
	} finally {
		await fixture.release();
		await reload.catch(() => undefined);
	}
	expect(await (await reload).json()).toMatchObject({ status: "live" });
	expect((await status()).child.pid).toBe(candidate);
	if (!pending) throw Error("Missing queued request");
	expect((await pending).status).toBe(403);
	expect((await write("after-must-not-write")).status).toBe(403);
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='ingress-cutover' ORDER BY seq")).toEqual([
		{ body: "before-cutover" },
	]);
	// The same new handler remains usable with board authority, proving it loaded successfully.
	const signed = await fetch(`${app.url}/managed-cutover`, {
		method: "POST",
		headers: { ...headers, "idempotency-key": "signed-after" },
		body: "signed-after",
	});
	expect(signed.status).toBe(200);
	expect(await signed.json()).toMatchObject({ body: "signed-after", agent: "rahul" });
	expect(await fixture.sql("SELECT body FROM messages WHERE topic='ingress-cutover' ORDER BY seq")).toEqual([
		{ body: "before-cutover" },
		{ body: "signed-after" },
	]);
}, 60000);
