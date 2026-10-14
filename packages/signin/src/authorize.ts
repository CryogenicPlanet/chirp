import { Clock, Duration, Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ClientMetadata } from "./client-metadata.ts";
import { Issuer } from "./issuer.ts";
import { consentPage, errorPage } from "./pages.ts";
import { open, randomToken, s256, sameSecret, seal } from "./seal.ts";
import { Settings } from "./settings.ts";
import { Identity, type Provider, providers, Upstream } from "./upstream.ts";

const cookie = "__Host-signin.tx";
const transactionLifetime = Duration.minutes(10);

/** The board's validated authorization request. */
const BoardRequest = Schema.Struct({
	client_id: Schema.String,
	redirect_uri: Schema.String,
	redirect_origin: Schema.String,
	state: Schema.optionalKey(Schema.String),
	nonce: Schema.String,
	code_challenge: Schema.String,
	provider: Schema.Literals(providers),
});
type BoardRequest = typeof BoardRequest.Type;

/** The sealed transaction cookie: waiting for the upstream callback, then waiting for consent. */
const Transaction = Schema.Union([
	Schema.Struct({
		stage: Schema.Literal("upstream"),
		request: BoardRequest,
		upstream_state: Schema.String,
		upstream_verifier: Schema.String,
		exp: Schema.Int,
	}),
	Schema.Struct({
		stage: Schema.Literal("consent"),
		request: BoardRequest,
		identity: Identity,
		auth_time: Schema.Int,
		csrf: Schema.String,
		exp: Schema.Int,
	}),
]);

/** Rendered as a page. Used whenever the redirect_uri is not, or no longer, known to be the board's. */
class Refused extends Schema.TaggedError<Refused>()("Refused", { status: Schema.Int, message: Schema.String }) {}
/** Sent back to the validated redirect_uri as an RFC 6749 §4.1.2.1 error with RFC 9207 iss. */
class Declined extends Schema.TaggedError<Declined>()("Declined", {
	error: Schema.String,
	redirect_uri: Schema.String,
	state: Schema.optionalKey(Schema.String),
}) {}
const decline = (error: string, board: Pick<BoardRequest, "redirect_uri" | "state">) =>
	new Declined({
		error,
		redirect_uri: board.redirect_uri,
		...(board.state === undefined ? {} : { state: board.state }),
	});

const restart = "This sign-in expired or was started in another browser. Return to the board and sign in again.";
const clientMessages = {
	invalid_client_id: "The client_id is not a valid client metadata URL.",
	invalid_redirect_uri: "The redirect_uri is not a valid https URL.",
	private_address: "The client metadata URL resolves to an address this service will not contact.",
	unreachable: "The client metadata document could not be fetched.",
	redirected: "The client metadata URL redirected. Redirects are not followed.",
	too_large: "The client metadata document is larger than 8 KB.",
	invalid_document: "The client metadata document is not valid client metadata.",
	client_id_mismatch: "The client metadata document names a different client_id.",
	unsupported_auth_method: 'The client metadata must set token_endpoint_auth_method to "none".',
	unregistered_redirect_uri: "The redirect_uri is not listed in the client's redirect_uris.",
} as const;

// __Host- cookies need Secure and Path=/ and no Domain, including when they are expired.
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;
// A bare number for maxAge would be milliseconds.
const transactionCookie = (value: string) =>
	HttpServerResponse.setCookieUnsafe(cookie, value, { ...cookieOptions, maxAge: transactionLifetime });
const clearCookie = HttpServerResponse.expireCookieUnsafe(cookie, cookieOptions);

/** Exactly one transaction cookie; a duplicate means another cookie was planted beside ours. */
const readCookie = (request: HttpServerRequest.HttpServerRequest) => {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${cookie}=`));
	return values.length === 1 ? values[0]?.slice(cookie.length + 1) : undefined;
};

const openTransaction = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const settings = yield* Settings;
		const sealed = readCookie(request);
		if (!sealed) return yield* new Refused({ status: 400, message: restart });
		const transaction = yield* open(settings.sealKey, "transaction", Transaction, sealed).pipe(
			Effect.mapError(() => new Refused({ status: 400, message: restart })),
		);
		if (transaction.exp <= (yield* Clock.currentTimeMillis))
			return yield* new Refused({ status: 400, message: restart });
		return transaction;
	});

const finish = <R>(flow: Effect.Effect<HttpServerResponse.HttpServerResponse, Refused | Declined, R>) =>
	Effect.gen(function* () {
		const settings = yield* Settings;
		return yield* flow.pipe(
			Effect.catchTags({
				Refused: (refused) => Effect.succeed(errorPage(refused.status, refused.message)),
				Declined: (declined) => {
					const url = new URL(declined.redirect_uri);
					url.searchParams.set("error", declined.error);
					if (declined.state !== undefined) url.searchParams.set("state", declined.state);
					url.searchParams.set("iss", settings.issuer);
					return Effect.succeed(
						HttpServerResponse.redirect(url.href, { status: 303, headers: { "cache-control": "no-store" } }).pipe(
							clearCookie,
						),
					);
				},
			}),
		);
	});

const queryOf = (request: HttpServerRequest.HttpServerRequest, issuer: string) =>
	new URL(request.url, issuer).searchParams;
const bounded = (value: string | null, max: number) =>
	value !== null && value.length > 0 && value.length <= max ? value : undefined;

/** Validate the board, then hand the browser to GitHub or Google with our own state and PKCE. */
export const authorizeRoute = finish(
	Effect.gen(function* () {
		const settings = yield* Settings;
		const request = yield* HttpServerRequest.HttpServerRequest;
		const query = queryOf(request, settings.issuer);
		const names = [...query.keys()];
		if (new Set(names).size !== names.length)
			return yield* new Refused({ status: 400, message: "A request parameter appears more than once." });
		const clientId = query.get("client_id");
		const redirectUri = query.get("redirect_uri");
		if (clientId === null || redirectUri === null)
			return yield* new Refused({ status: 400, message: "The request needs a client_id and a redirect_uri." });
		const client = yield* (yield* ClientMetadata)
			.resolve(clientId, redirectUri)
			.pipe(Effect.mapError((error) => new Refused({ status: 400, message: clientMessages[error.reason] })));

		// From here the redirect_uri is the board's, so errors go back to it.
		const state = query.get("state");
		const reply = { redirect_uri: client.redirectUri, ...(state === null ? {} : { state }) };
		if (query.get("response_type") !== "code") return yield* decline("unsupported_response_type", reply);
		if (!(query.get("scope") ?? "").split(" ").includes("openid")) return yield* decline("invalid_scope", reply);
		const nonce = bounded(query.get("nonce"), 256);
		const challenge = query.get("code_challenge");
		const provider = providers.find((name) => name === query.get("provider"));
		if (
			query.get("code_challenge_method") !== "S256" ||
			challenge === null ||
			!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
			nonce === undefined ||
			provider === undefined ||
			(state !== null && bounded(state, 256) === undefined)
		)
			return yield* decline("invalid_request", reply);
		const board: BoardRequest = {
			client_id: client.clientId,
			redirect_uri: client.redirectUri,
			redirect_origin: client.redirectOrigin,
			...(state === null ? {} : { state }),
			nonce,
			code_challenge: challenge,
			provider,
		};

		const upstreamState = yield* randomToken(32);
		const upstreamVerifier = yield* randomToken(32);
		const sealed = yield* seal(settings.sealKey, "transaction", Transaction, {
			stage: "upstream",
			request: board,
			upstream_state: upstreamState,
			upstream_verifier: upstreamVerifier,
			exp: (yield* Clock.currentTimeMillis) + Duration.toMillis(transactionLifetime),
		});
		const location = (yield* Upstream).authorizeUrl(provider, {
			state: upstreamState,
			challenge: yield* s256(upstreamVerifier),
			nonce: yield* randomToken(16),
		});
		return HttpServerResponse.redirect(location, {
			status: 303,
			headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
		}).pipe(transactionCookie(sealed));
	}),
);

/** Finish the upstream sign-in and ask for consent. The identity waits in the sealed cookie, never in the form. */
export const callbackRoute = (provider: Provider) =>
	finish(
		Effect.gen(function* () {
			const settings = yield* Settings;
			const request = yield* HttpServerRequest.HttpServerRequest;
			const query = queryOf(request, settings.issuer);
			const transaction = yield* openTransaction(request);
			const state = query.get("state");
			if (
				transaction.stage !== "upstream" ||
				transaction.request.provider !== provider ||
				state === null ||
				!sameSecret(state, transaction.upstream_state)
			)
				return yield* new Refused({ status: 400, message: restart });
			const board = transaction.request;
			// Only a person's refusal is a denial; a provider outage stays retryable and anything else is the issuer's fault.
			const upstreamError = query.get("error");
			if (upstreamError !== null)
				return yield* decline(
					upstreamError === "access_denied" || upstreamError === "temporarily_unavailable"
						? upstreamError
						: "server_error",
					board,
				);
			const code = query.get("code");
			if (!code) return yield* decline("server_error", board);
			const identity = yield* (yield* Upstream).identify(provider, code, transaction.upstream_verifier).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Upstream sign-in failed").pipe(
						Effect.annotateLogs({ provider: error.provider, step: error.step }),
					),
				),
				Effect.mapError(() => decline("server_error", board)),
			);
			const now = yield* Clock.currentTimeMillis;
			const csrf = yield* randomToken(32);
			const sealed = yield* seal(settings.sealKey, "transaction", Transaction, {
				stage: "consent",
				request: board,
				identity,
				auth_time: Math.floor(now / 1000),
				csrf,
				exp: now + Duration.toMillis(transactionLifetime),
			});
			return consentPage({ destination: board.redirect_origin, clientId: board.client_id, identity, csrf }).pipe(
				transactionCookie(sealed),
			);
		}),
	);

/** Same-origin form POST with the page's CSRF token. Continue issues the code; cancel declines. */
export const consentRoute = finish(
	Effect.gen(function* () {
		const settings = yield* Settings;
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (request.headers.origin !== settings.issuer)
			return yield* new Refused({ status: 403, message: "This confirmation did not come from the sign-in page." });
		const transaction = yield* openTransaction(request);
		if (transaction.stage !== "consent") return yield* new Refused({ status: 400, message: restart });
		const form = new URLSearchParams(
			(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")
				? yield* request.text.pipe(Effect.orElseSucceed(() => ""))
				: "",
		);
		const csrf = form.getAll("csrf");
		if (csrf.length !== 1 || !sameSecret(csrf[0] ?? "", transaction.csrf))
			return yield* new Refused({ status: 403, message: "This confirmation did not come from the sign-in page." });
		const board = transaction.request;
		const decision = form.getAll("decision");
		if (decision.length === 1 && decision[0] === "cancel") return yield* decline("access_denied", board);
		if (decision.length !== 1 || decision[0] !== "continue")
			return yield* new Refused({ status: 400, message: "Choose Continue or Cancel." });
		const code = yield* (yield* Issuer).issueCode({
			client_id: board.client_id,
			redirect_uri: board.redirect_uri,
			code_challenge: board.code_challenge,
			nonce: board.nonce,
			auth_time: transaction.auth_time,
			identity: transaction.identity,
		});
		const url = new URL(board.redirect_uri);
		url.searchParams.set("code", code);
		if (board.state !== undefined) url.searchParams.set("state", board.state);
		url.searchParams.set("iss", settings.issuer);
		return HttpServerResponse.redirect(url.href, { status: 303, headers: { "cache-control": "no-store" } }).pipe(
			clearCookie,
		);
	}),
);
