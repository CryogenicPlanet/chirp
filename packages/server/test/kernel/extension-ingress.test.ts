import { applicationIngressPath, ingressTargetHeader } from "@comms/protocol/headers";
import { Effect } from "effect";
import { FindMyWay, HttpServerRequest } from "effect/unstable/http";
import { expect, it } from "vitest";
import { selectRequest, exposeRequest } from "../../src/kernel/extension-ingress.ts";

it("uses normal route precedence and never falls back from the anonymous envelope", async () => {
	const matcher = FindMyWay.make<{ readonly access: "board" | "application-managed" }>();
	matcher.on("GET", "/api/private", { access: "board" });
	matcher.on("GET", "/api/*", { access: "application-managed" });
	matcher.on("GET", "/*", { access: "application-managed" });
	const select = (target: string, method = "GET") =>
		Effect.runPromise(
			selectRequest(
				matcher,
				HttpServerRequest.fromWeb(
					new Request(`http://child${applicationIngressPath}`, { method, headers: { [ingressTargetHeader]: target } }),
				),
			),
		);
	expect((await select("/api/open?x=1"))?.matched.handler.access).toBe("application-managed");
	expect((await select("/api/open", "HEAD"))?.matched.handler.access).toBe("application-managed");
	for (const path of [
		"/api/private",
		"/_boot/status",
		"/_kernel/control",
		"/auth/login",
		"/api/%66s/app",
		"/API/fs/app",
		"//host/api/open",
		"/api\\private",
	])
		await expect(select(path)).rejects.toThrow();
	await expect(select("/api/open", "POST")).rejects.toThrow();
	const regular = await Effect.runPromise(
		selectRequest(matcher, HttpServerRequest.fromWeb(new Request("http://child/health"))),
	);
	expect(regular).toBeNull();
});

it("exposes only app cookies and preserves the original request body and URL", async () => {
	const source = HttpServerRequest.fromWeb(
		new Request(`http://child${applicationIngressPath}`, {
			method: "POST",
			body: "payload",
			headers: {
				cookie: "session=secret; chirp_app_gate=ok; unrelated=no",
				authorization: "Bearer secret",
				"x-boot-secret": "secret",
				[ingressTargetHeader]: "/custom?q=yes",
			},
		}),
	);
	const exposed = await Effect.runPromise(exposeRequest(source, "/custom?q=yes", true));
	expect(exposed.url).toBe("/custom?q=yes");
	expect(exposed.headers.cookie).toBe("chirp_app_gate=ok");
	expect(await Effect.runPromise(exposed.text)).toBe("payload");
	for (const header of ["authorization", "x-boot-secret", ingressTargetHeader])
		expect(exposed.headers[header]).toBeUndefined();
	const normal = await Effect.runPromise(
		exposeRequest(
			HttpServerRequest.fromWeb(new Request("http://child/custom", { headers: { cookie: "chirp_app_gate=ok" } })),
			"/custom",
			false,
		),
	);
	expect(normal.headers.cookie).toBeUndefined();
});
