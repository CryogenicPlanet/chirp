import { requestIdHeader, tokenExpiresHeader } from "@comms/protocol/headers";
import { bootRoute, checkBootOrigin } from "./boot-route.ts";
import { Console, Duration, Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { AuthError, type Auth } from "./auth.ts";
import {
	assertionProof,
	authFailure,
	body,
	humanSession,
	namesGrant,
	refusalStatus,
	sessionResponse,
} from "./auth-http.ts";
import { oidcCallbackPath, oidcClientPath, oidcLifetimeMs } from "./identity-links.ts";
import { oidcContinuePage, oidcErrorPage, oidcPageHeaders } from "./oidc-page.ts";
import { OidcStart } from "./oidc-schema.ts";

/** Binds a sign-in round trip to the browser that started it. Lax, because the issuer's redirect back is a cross-site
 * top-level navigation; the proxy never forwards it to the app or lets the app set it. */
export const oidcCookie = "__Host-chirp_oidc";

const binding = (header: string | undefined) => {
	const values = (header ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${oidcCookie}=`))
		.map((part) => part.slice(oidcCookie.length + 1));
	const value = values[0];
	return values.length === 1 && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};
const clearBinding = HttpServerResponse.setCookieUnsafe(oidcCookie, "", {
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAge: 0,
});

/** Exact paths only. The client document and callback are public; every other route needs the human session. */
export const oidcRoute = (auth: Auth["Service"], requestId: string) =>
	Effect.gen(function* () {
		const { request, url } = yield* bootRoute;
		const path = url.pathname;
		const method = request.method;
		const client = method === "GET" && path === oidcClientPath;
		const start = method === "POST" && path === "/_boot/auth/oidc/start";
		const callback = method === "GET" && path === oidcCallbackPath;
		const list = method === "GET" && path === "/_boot/auth/identities";
		const link = method === "POST" && path === "/_boot/auth/identities";
		const unlink = method === "DELETE" ? /^\/_boot\/auth\/identities\/([a-f0-9]{64})$/.exec(path)?.[1] : undefined;
		if (!client && !start && !callback && !list && !link && !unlink) return null;
		if (client)
			return yield* authFailure(
				Effect.map(auth.oidcClientDocument, (document) =>
					document === null
						? HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } })
						: HttpServerResponse.jsonUnsafe(document, { headers: { "cache-control": "no-store" } }),
				),
			);
		if (callback) {
			const single = (name: string) => {
				const values = url.searchParams.getAll(name);
				return values.length === 1 ? values[0] : undefined;
			};
			const state = single("state");
			const code = single("code");
			const iss = single("iss");
			// Read before the callback spends the state, so a refusal can say whether it was a sign-in or a link.
			const linking =
				state !== undefined && (yield* auth.oidcIntent(state).pipe(Effect.orElseSucceed(() => null))) === "link";
			const page = (refusal: AuthError["code"]) =>
				HttpServerResponse.text(oidcErrorPage(refusal, { canceled: url.searchParams.has("error"), linking }), {
					status: refusalStatus(refusal),
					contentType: "text/html",
					headers: oidcPageHeaders,
				}).pipe(clearBinding);
			return yield* authFailure(
				Effect.gen(function* () {
					// A credential beside the callback, or no single state, finishes nothing. Anything else naming a live
					// state reaches boot's check, which spends that state on any refusal, including an issuer error.
					if (request.headers.authorization !== undefined || namesGrant(request) || state === undefined)
						return yield* new AuthError({ code: "oidc_invalid" });
					const result = yield* auth.finishOidc({
						state,
						code,
						iss,
						binding: binding(request.headers.cookie),
						refused: url.searchParams.has("error"),
					});
					yield* Console.error(`boot.auth stage=oidc_callback outcome=${result._tag} request_id=${requestId}`);
					const response = HttpServerResponse.text(oidcContinuePage(result.next), {
						contentType: "text/html",
						headers: oidcPageHeaders,
					}).pipe(clearBinding);
					if (result._tag === "pending") return response;
					// Exactly the session cookie and expiry a passkey sign-in sets.
					const signedIn = sessionResponse(result.session);
					return response.pipe(
						HttpServerResponse.mergeCookies(signedIn.cookies),
						HttpServerResponse.setHeader(tokenExpiresHeader, String(result.session.expiresAt)),
					);
				}).pipe(
					Effect.catchTag("AuthError", (error) =>
						Console.error(`boot.auth stage=oidc_callback outcome=${error.code} request_id=${requestId}`).pipe(
							Effect.as(page(error.code)),
						),
					),
				),
			).pipe(Effect.map(HttpServerResponse.setHeader(requestIdHeader, requestId)));
		}
		return yield* authFailure(
			Effect.gen(function* () {
				if (url.search) return yield* new AuthError({ code: "invalid_request" });
				if (start) {
					// Login has no session yet, but an agent credential never starts one.
					if (request.headers.authorization !== undefined || namesGrant(request))
						return yield* new AuthError({ code: "session_invalid" });
					const party = yield* auth.relyingParty(request.headers.origin);
					const input = yield* body(OidcStart);
					const session = input.intent === "link" ? yield* humanSession(auth, request) : null;
					const started = yield* auth.startOidc(input, party, session?.id ?? null);
					return HttpServerResponse.jsonUnsafe({ authorization_url: started.authorizationUrl }).pipe(
						HttpServerResponse.setCookieUnsafe(oidcCookie, started.binding, {
							httpOnly: true,
							secure: true,
							sameSite: "lax",
							path: "/",
							maxAge: Duration.millis(oidcLifetimeMs),
						}),
					);
				}
				yield* checkBootOrigin(list ? "passkeyRead" : "authWrite", request, auth);
				const session = yield* humanSession(auth, request);
				if (list) return HttpServerResponse.jsonUnsafe(yield* auth.listIdentities(session.id));
				if (link) {
					const input = yield* body(Schema.Struct({ pending: Schema.String }));
					const proof = yield* assertionProof(request);
					return HttpServerResponse.jsonUnsafe(yield* auth.linkIdentity({ id: input.pending }, proof, session.id));
				}
				if (unlink === undefined) return HttpServerResponse.empty({ status: 404 });
				yield* body(Schema.Struct({}));
				const proof = yield* assertionProof(request);
				return HttpServerResponse.jsonUnsafe(yield* auth.unlinkIdentity({ id: unlink }, proof, session.id));
			}).pipe(Effect.map(HttpServerResponse.setHeader("cache-control", "no-store"))),
		);
	});
