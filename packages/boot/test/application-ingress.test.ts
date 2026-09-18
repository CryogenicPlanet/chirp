import { agentHeader, ingressTargetHeader } from "@comms/protocol/headers";
import { expect, it } from "vitest";
import { applicationCookies, isReservedIngressPath } from "../src/application-ingress.ts";
import { launch } from "./fixtures/proxy-launch.ts";

it("keeps board credentials and reserved aliases outside application ingress", () => {
	expect(
		applicationCookies("__Host-comms_session=secret; chirp_app_login=app; other=private; chirp_app_bad name=x"),
	).toBe("chirp_app_login=app");
	for (const path of [
		"/_boot/status",
		"/%5fboot/status",
		"/%61uth/login",
		"/x/../api/fs/app",
		"/%2f_kernel/control",
		"/auth%5clogin",
		"/%",
		"/api/reload",
	])
		expect(isReservedIngressPath(path), path).toBe(true);
	expect(isReservedIngressPath("/shared/page")).toBe(false);
});

it.for([
	undefined,
	'{"applicationManagedIngress":false}',
	'{"applicationManagedIngress":"true"}',
	'{"applicationManagedIngress":true,"typo":true}',
	"{broken",
])("refuses anonymous ingress with absent, off, or invalid configuration %s", async (config, test) => {
	const app = await launch(test, "ingress", false, {}, config);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	expect((await fetch(`${app.url}/shared`)).status).toBe(401);
	expect((await fetch(`${app.url}/_boot/auth/state`)).status).toBe(200);
	const status = await (await app.fetch(`${app.url}/_boot/status`)).json();
	expect(status.ingress.applicationManagedIngress).toBe(false);
	if (config && config !== '{"applicationManagedIngress":false}')
		expect(status.ingress.error).toBe("boot_config_invalid");
});

it("never sends anonymous requests to a historical child without the health capability", async (test) => {
	const app = await launch(test, "normal", false, {}, '{"applicationManagedIngress":true}');
	await expect.poll(async () => (await app.state()).state).toBe("live");
	expect((await fetch(`${app.url}/shared`)).status).toBe(401);
	expect((await fetch(`${app.url}/shared`, { method: "POST", body: "write" })).status).toBe(401);
	expect((await app.fetch(`${app.url}/echo`)).status).toBe(200);
});

it("delegates anonymous reads and intentional writes only through the dedicated envelope", async (test) => {
	const app = await launch(test, "ingress", false, {}, '{"applicationManagedIngress":true}');
	await expect.poll(async () => (await app.state()).state).toBe("live");
	for (const method of ["GET", "POST"]) {
		const response = await fetch(`${app.url}/shared?q=a%2Fb`, {
			method,
			...(method === "POST" ? { body: "write" } : {}),
			headers: {
				[agentHeader]: "forged",
				[ingressTargetHeader]: "/api/fs",
				cookie: "other=private; chirp_app_login=app",
			},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			target: "/shared?q=a%2Fb",
			method,
			body: method === "POST" ? "write" : "",
			cookie: "chirp_app_login=app",
			authorization: null,
			agent: null,
		});
	}
	expect((await fetch(`${app.url}/shared`, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
	expect(
		(await fetch(`${app.url}/shared`, { headers: { cookie: "__Host-comms_session=invalid; chirp_app_login=app" } }))
			.status,
	).toBe(401);
	for (const path of ["/_kernel/ingress", "/%5fkernel/ingress", "/%61uth/unknown", "/api/fs/app", "/_boot/unknown"])
		expect((await fetch(`${app.url}${path}`)).status).toBeGreaterThanOrEqual(400);
	const authenticated = await fetch(`${app.url}/echo`, {
		headers: { cookie: `${app.cookie}; chirp_app_login=app; other=private` },
	});
	expect(await authenticated.json()).toMatchObject({
		path: "/echo",
		cookie: "chirp_app_login=app",
		kind: "human",
		agent: "rahul",
		authorization: null,
	});
});
