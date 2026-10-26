import { type Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { authorizeRoute, callbackRoute, consentRoute, signOutRoute } from "./authorize.ts";
import { discoveryRoute, jwksRoute, tokenRoute } from "./issuer.ts";
import { signOutPage } from "./pages.ts";

const describe = <E = never, R = never>(
	method: "GET" | "POST",
	path: HttpRouter.PathInput,
	description: string,
	handler: HttpServerResponse.HttpServerResponse | Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => ({ line: `${method} ${path} - ${description}`, route: HttpRouter.add(method, path, handler) });

/** Every route and what it does. `GET /` serves this table, so the list cannot drift from the router. */
const described = [
	describe(
		"GET",
		"/health",
		'Liveness. Answers {status:"ok"}.',
		HttpServerResponse.jsonUnsafe({ status: "ok" }, { headers: { "cache-control": "no-store" } }),
	),
	describe(
		"GET",
		"/.well-known/openid-configuration",
		"OpenID Provider metadata: endpoints, ES256, S256 PKCE, public clients, RFC 9207 iss and client ID metadata documents.",
		discoveryRoute,
	),
	describe("GET", "/jwks.json", "The public ES256 key that signs ID tokens, with its kid.", jwksRoute),
	describe(
		"GET",
		"/authorize",
		"Authorization code request with provider=github|google. client_id is the board's client metadata URL. Errors before the redirect_uri is validated render a page; later errors redirect with error, state and iss. With that provider's session cookie, a board already consented to gets a code at once (303 with code, state and iss) and another board gets the consent page; otherwise the browser goes to the provider.",
		authorizeRoute,
	),
	describe(
		"GET",
		"/callback/github",
		"GitHub returns here. Finishes the GitHub sign-in and shows the consent page.",
		callbackRoute("github"),
	),
	describe(
		"GET",
		"/callback/google",
		"Google returns here. Finishes the Google sign-in and shows the consent page.",
		callbackRoute("google"),
	),
	describe(
		"POST",
		"/consent",
		"The consent form: Origin must be this issuer and the page's CSRF token present. Continue redirects (303) with code, state and iss and remembers the board in the provider's 30-day session cookie; cancel redirects with error=access_denied.",
		consentRoute,
	),
	describe(
		"GET",
		"/signout",
		"The sign-out page. Its form posts to POST /signout; visiting it changes nothing.",
		signOutPage,
	),
	describe(
		"POST",
		"/signout",
		"Sign out: Origin must be this issuer. Expires the GitHub and Google session cookies and any sign-in in progress, so the next sign-in goes to the provider. Boards keep their own sessions.",
		signOutRoute,
	),
	describe(
		"POST",
		"/token",
		"Form-encoded authorization_code exchange with PKCE. Codes are single-use, live 60 s and are bound to client_id, redirect_uri, code_challenge and nonce. Returns a 5-minute ES256 ID token.",
		tokenRoute,
	),
];

const index = [
	"chirp sign-in: an OpenID Connect issuer for chirp boards, signing in with GitHub or Google.",
	"",
	"GET / - This list.",
	...described.map((route) => route.line),
	"",
].join("\n");

export const routes = Layer.mergeAll(
	HttpRouter.add("GET", "/", HttpServerResponse.text(index)),
	...described.map((route) => route.route),
);
