import { applicationIngressPath, ingressTargetHeader } from "@comms/protocol/headers";
import { Effect } from "effect";
import { FindMyWay, HttpServerRequest } from "effect/unstable/http";
import { expect, it } from "vitest";
import { selectRequest, exposeRequest } from "../../src/kernel/extension-ingress.ts";

const everyExtension = () => true;

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
				everyExtension,
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
		"/api/open?value=a\\b",
	])
		await expect(select(path)).rejects.toThrow();
	await expect(select("/api/open", "POST")).rejects.toThrow();
	const regular = await Effect.runPromise(
		selectRequest(matcher, HttpServerRequest.fromWeb(new Request("http://child/health")), everyExtension),
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

it("exposes an application bearer only to the managed envelope, including request.source", async () => {
	const authorization = `Bearer chirp_app_${"a".repeat(43)}`;
	for (const [url, managed, expected] of [
		[applicationIngressPath, true, authorization],
		[applicationIngressPath, false, null],
		["/custom", true, null],
	] as const) {
		const exposed = await Effect.runPromise(
			exposeRequest(
				HttpServerRequest.fromWeb(
					new Request(`http://child${url}`, { headers: { authorization, "x-boot-secret": "secret" } }),
				),
				"/custom",
				managed,
			),
		);
		expect(exposed.headers.authorization ?? null).toBe(expected);
		const web = await Effect.runPromise(HttpServerRequest.toWeb(exposed));
		expect(web.headers.get("authorization")).toBe(expected);
		expect(web.headers.get("x-boot-secret")).toBeNull();
	}
});

it("selects the owning core route for ordinary queries requiring handler validation", async () => {
	const matcher = FindMyWay.make<{ readonly access: "board" }>();
	const handler = { access: "board" } as const;
	matcher.on("GET", "/api/messages", handler);
	matcher.on("GET", "/api/topics", handler);
	for (const target of ["/api/messages?topic=gen\\eral", "/api/topics?cursor=a\\b"]) {
		const request = HttpServerRequest.fromWeb(new Request(`http://child${target}`));
		const selected = await Effect.runPromise(selectRequest(matcher, request, everyExtension));
		expect(selected?.matched.handler).toBe(handler);
		expect(selected?.target).toBe(target);
		expect(selected?.envelope).toBe(false);
	}
});

it("rejects empty named parameters without rejecting an empty terminal wildcard", async () => {
	const matcher = FindMyWay.make<{ readonly access: "board" | "application-managed" }>();
	matcher.on("GET", "/:name", { access: "board" });
	matcher.on("GET", "/api/:id/end", { access: "board" });
	for (const target of ["/", "/api//end"]) {
		const regular = await Effect.runPromise(
			selectRequest(matcher, HttpServerRequest.fromWeb(new Request(`http://child${target}`)), everyExtension),
		);
		expect(regular).toBeNull();
		await expect(
			Effect.runPromise(
				selectRequest(
					matcher,
					HttpServerRequest.fromWeb(
						new Request(`http://child${applicationIngressPath}`, { headers: { [ingressTargetHeader]: target } }),
					),
					everyExtension,
				),
			),
		).rejects.toThrow();
	}
	const wildcardMatcher = FindMyWay.make<{ readonly access: "application-managed" }>({
		caseSensitive: true,
		ignoreTrailingSlash: false,
		ignoreDuplicateSlashes: false,
	});
	wildcardMatcher.on("GET", "/prefix/:bucket/*", { access: "application-managed" });
	const wildcard = await Effect.runPromise(
		selectRequest(wildcardMatcher, HttpServerRequest.fromWeb(new Request("http://child/prefix/docs/")), everyExtension),
	);
	expect(wildcard?.matched.params).toEqual({ bucket: "docs", "*": "" });
});

it("refuses the anonymous envelope for a managed route whose extension ingress does not admit", async () => {
	const matcher = FindMyWay.make<{ readonly access: "application-managed"; readonly extension: string }>();
	matcher.on("GET", "/mcp", { access: "application-managed", extension: "mcp" });
	matcher.on("GET", "/shared", { access: "application-managed", extension: "public-pages.ts" });
	const select = (url: string, target?: string) =>
		Effect.runPromise(
			selectRequest(
				matcher,
				HttpServerRequest.fromWeb(
					new Request(`http://child${url}`, target ? { headers: { [ingressTargetHeader]: target } } : {}),
				),
				(route) => route.extension === "mcp",
			),
		);
	expect((await select(applicationIngressPath, "/mcp"))?.matched.handler.extension).toBe("mcp");
	await expect(select(applicationIngressPath, "/shared")).rejects.toThrow();
	// A request boot authenticated is not anonymous ingress, so the route still owns it.
	expect((await select("/shared"))?.matched.handler.extension).toBe("public-pages.ts");
});
