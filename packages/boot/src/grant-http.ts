import { assertionHeader } from "@comms/protocol/headers";
import { bootRoute } from "./boot-route.ts";
import { liveChannelAttempt, reachesAttempt } from "./internal-channel.ts";
import { Effect, Ref, Schema } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth, type AuthConfig } from "./auth.ts";
import { authFailure, body, namesGrant } from "./auth-http.ts";
import { Scope } from "./enrollment-schema.ts";
import type { SupervisedChild } from "./supervisor.ts";

/**
 * The live app's private channel: no other credential may ride along, and no proxy may stand in between.
 * Returns the validated attempt, so admission can confirm the request still reaches that same live generation.
 */
export const grantChannel = (request: HttpServerRequest.HttpServerRequest, child: SupervisedChild) =>
	Effect.gen(function* () {
		const attempt = liveChannelAttempt(request, yield* Ref.get(child.attempts), yield* Ref.get(child.traffic.route));
		return attempt !== null &&
			request.headers.authorization === undefined &&
			request.headers.cookie === undefined &&
			request.headers[assertionHeader] === undefined
			? attempt
			: null;
	});

/**
 * What a grant may reach. Boot's own surfaces, authentication, approval and every operation that rewrites history
 * or another agent's work stay with people and their own tokens: reset, revert, restore, backup and token routes.
 * App source may only be staged; a grant reloads through POST /api/reload, which boot detaches.
 */
export const grantPathAllowed = (method: string, url: URL) => {
	const path = url.pathname;
	const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
	if (under("/_boot")) return method === "GET" && (path === "/_boot/status" || path === "/_boot/generations");
	if (["/auth", "/approve", "/setup", "/api/revert", "/api/reset", "/api/tokens"].some(under)) return false;
	if (under("/api/lock")) return !url.searchParams.has("break");
	if (path.startsWith("/api/fs/") && method !== "GET" && method !== "HEAD") {
		const name = (() => {
			try {
				return decodeURIComponent(path.slice("/api/fs/".length));
			} catch {
				return null;
			}
		})();
		if (name === null) return false;
		return name.startsWith("pages/") || url.searchParams.getAll("reload").join(",") === "0";
	}
	return true;
};

/** Held enrollment creation and collection. Neither response ever carries a credential. */
export const grantRoute = (auth: Auth["Service"], config: AuthConfig, child: SupervisedChild) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const path = url.pathname;
		if (path !== "/_boot/grants" && !path.startsWith("/_boot/grants/")) return null;
		return yield* authFailure(
			Effect.gen(function* () {
				const channel = namesGrant(request) ? null : yield* grantChannel(request, child);
				if (channel === null) return yield* new AuthError({ code: "grant_forbidden" });
				// Reading the body can outlast a cutover, so the attempt must still be the routed live one before acting.
				const stillLive = Effect.gen(function* () {
					if (!reachesAttempt(yield* Ref.get(child.traffic.route), channel.epoch))
						return yield* new AuthError({ code: "grant_forbidden" });
				});
				if (request.method !== "POST" || url.search) return yield* new AuthError({ code: "invalid_request" });
				if (path === "/_boot/grants") {
					const input = yield* body(
						Schema.Struct({
							extension: Schema.String,
							agent: Schema.String,
							label: Schema.String,
							scopes: Schema.Array(Scope),
						}),
					);
					yield* stillLive;
					const created = yield* auth.createHeldEnrollment(input);
					return HttpServerResponse.jsonUnsafe({
						...created,
						approve_url: `${config.expectedOrigin}/approve/${created.id}`,
					});
				}
				const id = /^\/_boot\/grants\/(e_[A-Za-z0-9_-]{43})$/.exec(path)?.[1];
				if (!id) return yield* new AuthError({ code: "enrollment_invalid" });
				const input = yield* body(Schema.Struct({ extension: Schema.String }));
				yield* stillLive;
				return HttpServerResponse.jsonUnsafe(yield* auth.collectHeldEnrollment(id, input.extension));
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
