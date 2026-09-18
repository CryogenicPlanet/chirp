import { assertionHeader, ingressChallengeHeader } from "@comms/protocol/headers";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

const boardChallenge = async (url: string) => {
	for (const path of [
		"/",
		"/t/topic?x=1",
		"/ext",
		"/@agent",
		"/p/private.md",
		"/api/messages",
		"/not-registered",
		"/quickstart.md",
	]) {
		const response = await fetch(url + path, { headers: { accept: "text/html" }, redirect: "manual" });
		expect(response.status, path).toBe(302);
		expect(response.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(path)}`);
		const api = await fetch(url + path, { headers: { accept: "application/json" } });
		expect(api.status, path).toBe(401);
		expect(api.headers.get(ingressChallengeHeader)).toBeNull();
	}
};

it("requires operator opt-in and persists explicitly managed writes with service authority", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "managed-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/managed.ts"),
		`import {Effect} from "effect";
export default api => {
 api.route("GET", "/onboarding", {description:"Explicit managed public builtin override",access:"application-managed",handler:async()=>Response.json("managed")});
 api.route("GET", "/managed/:id", {description:"Managed read",access:"application-managed",handler:(req,ctx)=>Effect.gen(function*(){
  const guard = yield* ctx.kv().set("accidental",true).pipe(Effect.result);
  const marks = yield* ctx.topics.markRead("managed",0).pipe(Effect.result);
  return Response.json({identity:ctx.identity,authority:ctx.authority,params:ctx.params,query:ctx.query,url:req.url,authorization:req.headers.authorization,headers:req.headers,cookie:req.headers.cookie,guard:guard._tag,marks:marks._tag}, {headers:{"set-cookie":"chirp_app_gate=approved; Path=/; HttpOnly; SameSite=Lax"}});
 })});
 api.route("POST", "/managed/:id", {description:"Intentional anonymous writer",access:"application-managed",handler:(req,ctx)=>Effect.gen(function*(){
  const body = yield* req.text;
  return Response.json(yield* ctx.messages.create({topic:"managed",body},req.headers["idempotency-key"]));
 })});
 api.route("GET", "/managed/private", {description:"Private precedence",scope:"read",handler:async()=>Response.json("private")});
 api.route("GET", "/managed/denied", {description:"App admission",access:"application-managed",handler:async()=>new Response("Password needed",{status:401,headers:{"x-chirp-ingress-challenge":"credential_required"}})});
 api.route("GET", "/managed/broken", {description:"Fail closed",access:"application-managed",handler:async()=>{throw Error("broken");}});
};`,
	);
	let app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	let cookie = await app.login();
	await app.ready(cookie);
	await boardChallenge(app.url);
	const authorization = `Bearer chirp_app_${"a".repeat(43)}`;
	expect((await fetch(`${app.url}/managed/hello`)).status).toBe(401);
	expect((await fetch(`${app.url}/managed/hello`, { headers: { authorization } })).status).toBe(401);
	expect((await fetch(`${app.url}/onboarding`)).status).toBeGreaterThanOrEqual(400);
	await app.stop();
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	app = await fixture.launch(join(seed, "server.ts"));
	cookie = await app.login();
	await app.ready(cookie);
	await boardChallenge(app.url);
	const response = await fetch(`${app.url}/managed/hello?tag=a&tag=b`, {
		headers: {
			cookie: "chirp_app_gate=approved; unrelated=hidden",
			"x-custom-proof": "proof",
			"x-chirp-agent": "spoof",
		},
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("set-cookie")).toContain("chirp_app_gate=approved");
	expect(await response.json()).toMatchObject({
		identity: null,
		authority: { actor: "system", instance: "extension:managed.ts" },
		params: { id: "hello" },
		query: { tag: ["a", "b"] },
		url: "/managed/hello?tag=a&tag=b",
		headers: { "x-custom-proof": "proof" },
		cookie: "chirp_app_gate=approved",
		guard: "Failure",
		marks: "Failure",
	});
	const bearer = await (
		await fetch(`${app.url}/managed/hello`, {
			headers: {
				authorization,
				"x-chirp-agent": "spoof",
				"x-chirp-auth-kind": "human",
				"x-boot-secret": "spoof",
				cookie: "chirp_app_gate=approved; unrelated=hidden",
			},
		})
	).json();
	expect(bearer.identity).toBeNull();
	expect(bearer.authorization).toBe(authorization);
	expect(bearer.cookie).toBe("chirp_app_gate=approved");
	expect(bearer.headers["x-boot-secret"]).toBeUndefined();
	expect(bearer.headers["x-chirp-agent"]).toBeUndefined();
	for (const mixedCookie of [cookie, "__Host-comms_session=invalid"])
		expect((await fetch(`${app.url}/managed/hello`, { headers: { authorization, cookie: mixedCookie } })).status).toBe(
			401,
		);
	for (const path of [
		"/managed/private",
		"/api/messages",
		"/p/private.md",
		"/not-registered",
		"/init",
		"/_boot/status",
	])
		expect((await fetch(`${app.url}${path}`, { headers: { authorization } })).status).toBeGreaterThanOrEqual(400);
	const bearerPrivate = await fetch(`${app.url}/managed/private`, {
		headers: { authorization, accept: "text/html" },
		redirect: "manual",
	});
	expect(bearerPrivate.status).toBe(401);
	expect(bearerPrivate.headers.get("location")).toBeNull();
	expect(await bearerPrivate.json()).toMatchObject({
		error: { code: "credential_required", hint: expect.any(String), retriable: false },
	});
	const signed = await (
		await fetch(`${app.url}/managed/hello`, { headers: { cookie: `${cookie}; chirp_app_gate=approved` } })
	).json();
	expect(signed.identity).toMatchObject({ agent: "rahul", kind: "human" });
	expect(signed.authority.actor).toBe("system");
	expect(signed.cookie).toBe("chirp_app_gate=approved");
	for (const path of ["/managed/private", "/api/messages", "/p/private.md", "/not-registered"])
		expect((await fetch(`${app.url}${path}`)).status).toBe(401);
	expect((await fetch(`${app.url}/managed/hello`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	const denied = await fetch(`${app.url}/managed/denied`, { headers: { accept: "text/html" }, redirect: "manual" });
	expect(denied.status).toBe(401);
	expect(denied.headers.get("location")).toBeNull();
	expect(denied.headers.get(ingressChallengeHeader)).toBeNull();
	expect(await denied.text()).toBe("Password needed");
	const malformedQuery = await fetch(`${app.url}/api/messages?topic=gen\\eral`, { headers: { cookie } });
	expect(malformedQuery.status).toBe(404);
	expect((await fetch(`${app.url}/managed/hello`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400);
	const enrollment = await (
		await app.post("/auth/enroll", { name: "managed-reader", kind: "agent", host: "test" })
	).json();
	const approval = { id: enrollment.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(approval);
	expect(
		(
			await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
				method: "POST",
				headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: proof },
				body: JSON.stringify({ decision: approval.decision, scopes: approval.scopes, long_lived: approval.long_lived }),
			})
		).status,
	).toBe(200);
	const token = await (
		await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })
	).json();
	expect(
		(
			await fetch(`${app.url}/managed/write`, {
				method: "POST",
				headers: { authorization: `Bearer ${token.access}` },
				body: "read token must not write",
			})
		).status,
	).toBe(403);

	const boardRead = await (
		await fetch(`${app.url}/managed/hello`, { headers: { authorization: `Bearer ${token.access}` } })
	).json();
	expect(boardRead.identity).toMatchObject({ agent: "managed-reader", kind: "agent" });
	expect(boardRead.authorization).toBeUndefined();

	const write = () =>
		fetch(`${app.url}/managed/write`, {
			method: "POST",
			headers: { "idempotency-key": "anonymous-one" },
			body: "durable anonymous",
		});
	const created = await write();
	expect(created.status).toBe(200);
	const message = await created.json();
	expect(message).toMatchObject({ agent: "system", body: "durable anonymous" });
	expect(await (await write()).json()).toEqual(message);
	const bearerWrite = await fetch(`${app.url}/managed/write`, {
		method: "POST",
		headers: { authorization, "idempotency-key": "bearer-one" },
		body: "bearer service",
	});
	expect(bearerWrite.status).toBe(200);
	expect(await bearerWrite.json()).toMatchObject({ agent: "system", body: "bearer service" });
	const signedWrite = await fetch(`${app.url}/managed/write`, {
		method: "POST",
		headers: { cookie, origin: "https://comms.test", "idempotency-key": "signed-one" },
		body: "signed service",
	});
	expect(await signedWrite.json()).toMatchObject({ agent: "system", body: "signed service" });
	const api = await (await fetch(`${app.url}/api`, { headers: { cookie } })).json();
	expect(api.paths["/managed/{id}"].post).toMatchObject({ security: [], "x-chirp-access": "application-managed" });
	expect(api.paths["/managed/private"].get.security.length).toBeGreaterThan(0);
	expect((await fetch(`${app.url}/managed/broken`)).status).toBe(500);
	expect((await fetch(`${app.url}/managed/hello`)).status).toBe(500);
	expect((await fetch(`${app.url}/managed/hello`, { headers: { authorization } })).status).toBe(500);
	await app.stop();
	app = await fixture.launch(join(seed, "server.ts"));
	cookie = await app.login();
	await app.ready(cookie);
	expect(await fixture.sql("SELECT body,agent FROM messages WHERE topic='managed' ORDER BY seq")).toEqual([
		{ body: "durable anonymous", agent: "system" },
		{ body: "bearer service", agent: "system" },
		{ body: "signed service", agent: "system" },
	]);
}, 60000);

it("closes anonymous ingress when a failed factory could have owned a narrower route", async (test) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "failed-seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	await writeFile(
		join(seed, "ext/a-broad.ts"),
		`export default api => api.route("GET","/shared/*",{description:"Broad public handler",access:"application-managed",handler:async()=>Response.json("must not leak")});`,
	);
	await writeFile(
		join(seed, "ext/b-private.ts"),
		`export default api => {api.route("GET","/shared/private",{description:"Private ownership",scope:"read",handler:async()=>Response.json("private")}); throw Error("factory failed after declaring private route");};`,
	);
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	await boardChallenge(app.url);
	expect((await fetch(`${app.url}/shared/private`)).status).toBe(401);
	expect(
		(await fetch(`${app.url}/shared/private`, { headers: { authorization: `Bearer chirp_app_${"a".repeat(43)}` } }))
			.status,
	).toBe(401);
	expect((await fetch(`${app.url}/shared/otherwise-public`)).status).toBe(401);
	expect((await fetch(`${app.url}/_boot/status`, { headers: { cookie } })).status).toBe(200);
	expect(await (await fetch(`${app.url}/api/ext`, { headers: { cookie } })).json()).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "b-private.ts", status: "disabled" })]),
	);
}, 25000);
