import {
	applicationBearerPattern,
	applicationCookiePrefix,
	applicationIngressPath,
	ingressTargetHeader,
} from "@comms/protocol/headers";
import { Effect } from "effect";
import { type FindMyWay, HttpServerRequest } from "effect/unstable/http";
import { KernelError } from "./boot-channel.ts";
import { requestPath, reserved } from "./extension-routes.ts";

/** The ordinary ownership matcher is also the only anonymous admission matcher. */
export const selectRequest = <Route extends { readonly access?: "board" | "application-managed" }>(
	matcher: FindMyWay.Router<Route>,
	request: HttpServerRequest.HttpServerRequest,
) =>
	Effect.gen(function* () {
		const envelope = request.url === applicationIngressPath;
		const target = envelope ? request.headers[ingressTargetHeader] : request.url;
		const refused = () => new KernelError({ code: "scope_required" });
		if (!target) return envelope ? yield* refused() : null;
		if (envelope && (!target.startsWith("/") || target.startsWith("//") || /[\\\r\n]/.test(target)))
			return yield* refused();
		const pathname = requestPath(target);
		if (pathname === null || reserved(pathname)) return envelope ? yield* refused() : null;
		const matched =
			matcher.find(request.method, target) ?? (request.method === "HEAD" ? matcher.find("GET", target) : undefined);
		if (!matched) return envelope ? yield* refused() : null;
		if (envelope && matched.handler.access !== "application-managed") return yield* refused();
		return { matched, target, envelope };
	});

/** Keep app credentials deliberately separate from board credentials, including Effect request.source. */
export const exposeRequest = (request: HttpServerRequest.HttpServerRequest, target: string, managed: boolean) =>
	Effect.gen(function* () {
		const web = yield* HttpServerRequest.toWeb(request);
		const headers = new Headers(web.headers);
		const applicationBearer =
			managed &&
			request.url === applicationIngressPath &&
			applicationBearerPattern.test(headers.get("authorization") ?? "")
				? headers.get("authorization")
				: null;
		for (const name of ["x-boot-secret", "authorization", ingressTargetHeader]) headers.delete(name);
		if (applicationBearer) headers.set("authorization", applicationBearer);
		const cookies = managed
			? (headers.get("cookie") ?? "")
					.split(";")
					.map((cookie) => cookie.trim())
					.filter((cookie) => cookie.startsWith(applicationCookiePrefix))
					.join("; ")
			: "";
		headers.delete("cookie");
		if (cookies) headers.set("cookie", cookies);
		return HttpServerRequest.fromWeb(
			new Request(new URL(target, web.url), {
				method: web.method,
				headers,
				...(web.body ? { body: web.body, duplex: "half" } : {}),
			}),
		);
	});
