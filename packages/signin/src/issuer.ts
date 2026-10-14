import { Clock, Context, Crypto, Effect, Layer, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { SignJWT } from "jose";
import { open, randomToken, s256, sameSecret, seal } from "./seal.ts";
import { Settings } from "./settings.ts";
import { Identity, providers } from "./upstream.ts";

const codeLifetime = 60_000;
const idTokenSeconds = 300;

/** Everything a code is bound to. The code is this grant, sealed; nothing is stored but its id once redeemed. */
const Grant = Schema.Struct({
	id: Schema.String,
	client_id: Schema.String,
	redirect_uri: Schema.String,
	code_challenge: Schema.String,
	nonce: Schema.String,
	auth_time: Schema.Int,
	exp: Schema.Int,
	identity: Identity,
});
type Grant = typeof Grant.Type;

const tokenErrors = ["invalid_request", "invalid_grant", "unsupported_grant_type"] as const;
export class TokenError extends Schema.TaggedError<TokenError>()("TokenError", {
	error: Schema.Literals(tokenErrors),
}) {}

type TokenRequest = {
	readonly code: string;
	readonly redirect_uri: string;
	readonly client_id: string;
	readonly code_verifier: string;
};

const make = Effect.gen(function* () {
	const settings = yield* Settings;
	const crypto = yield* Crypto.Crypto;
	// Ids of redeemed codes until they expire. One process is the single-use boundary, so run one machine.
	const redeemed = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
	const issuer = settings.issuer;
	const refuse = (error: (typeof tokenErrors)[number]) => new TokenError({ error });

	const discovery = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		jwks_uri: `${issuer}/jwks.json`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		id_token_signing_alg_values_supported: ["ES256"],
		subject_types_supported: ["public"],
		scopes_supported: ["openid"],
		claims_supported: [
			"iss",
			"aud",
			"azp",
			"sub",
			"iat",
			"exp",
			"nonce",
			"auth_time",
			"preferred_username",
			"email",
			"chirp_provider",
		],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
		chirp_providers: providers,
	} as const;
	const jwks = { keys: [settings.signing.publicJwk] } as const;

	const issueCode = (grant: Omit<Grant, "id" | "exp">) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			return yield* seal(settings.sealKey, "code", Grant, {
				...grant,
				id: yield* randomToken(16),
				exp: now + codeLifetime,
			});
		}).pipe(Effect.provideService(Crypto.Crypto, crypto));

	/** RFC 6749 §4.1.3 with RFC 7636 §4.6. Only a fully valid request consumes the code. */
	const redeem = (request: TokenRequest) =>
		Effect.gen(function* () {
			const grant = yield* open(settings.sealKey, "code", Grant, request.code).pipe(
				Effect.mapError(() => refuse("invalid_grant")),
			);
			const now = yield* Clock.currentTimeMillis;
			if (grant.exp <= now) return yield* refuse("invalid_grant");
			if (grant.client_id !== request.client_id || grant.redirect_uri !== request.redirect_uri)
				return yield* refuse("invalid_grant");
			if (!/^[A-Za-z0-9._~-]{43,128}$/.test(request.code_verifier)) return yield* refuse("invalid_request");
			if (!sameSecret(yield* s256(request.code_verifier), grant.code_challenge)) return yield* refuse("invalid_grant");
			const first = yield* Ref.modify(redeemed, (current) => {
				const live = new Map([...current].filter(([, exp]) => exp > now));
				if (live.has(grant.id)) return [false, live] as const;
				live.set(grant.id, grant.exp);
				return [true, live] as const;
			});
			if (!first) return yield* refuse("invalid_grant");
			const issuedAt = Math.floor(now / 1000);
			const { identity } = grant;
			const idToken = yield* Effect.tryPromise(() =>
				new SignJWT({
					azp: grant.client_id,
					nonce: grant.nonce,
					auth_time: grant.auth_time,
					chirp_provider: identity.provider,
					...(identity.username === undefined ? {} : { preferred_username: identity.username }),
					...(identity.email === undefined ? {} : { email: identity.email }),
				})
					.setProtectedHeader({ alg: "ES256", kid: settings.signing.kid, typ: "JWT" })
					.setIssuer(issuer)
					.setSubject(identity.sub)
					.setAudience(grant.client_id)
					.setIssuedAt(issuedAt)
					.setExpirationTime(issuedAt + idTokenSeconds)
					.sign(settings.signing.privateKey),
			).pipe(Effect.orDie);
			return {
				id_token: idToken,
				access_token: yield* randomToken(32),
				token_type: "Bearer",
				expires_in: idTokenSeconds,
			} as const;
		}).pipe(Effect.provideService(Crypto.Crypto, crypto));

	return { discovery, jwks, issueCode, redeem } as const;
});

export class Issuer extends Context.Service<Issuer, Effect.Success<typeof make>>()("comms/signin/Issuer") {}

export const layer = Layer.effect(Issuer, make);

const publicJson = (body: unknown) =>
	HttpServerResponse.jsonUnsafe(body, { headers: { "cache-control": "public, max-age=300" } });
const noStore = { "cache-control": "no-store", pragma: "no-cache" };

export const discoveryRoute = Effect.gen(function* () {
	return publicJson((yield* Issuer).discovery);
});
export const jwksRoute = Effect.gen(function* () {
	return publicJson((yield* Issuer).jwks);
});

/** Form-encoded, each parameter at most once, public client: no client authentication is read. */
export const tokenRoute = Effect.gen(function* () {
	const issuer = yield* Issuer;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const invalid = new TokenError({ error: "invalid_request" });
	return yield* Effect.gen(function* () {
		if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded"))
			return yield* invalid;
		const params = new URLSearchParams(yield* request.text.pipe(Effect.mapError(() => invalid)));
		const names = [...params.keys()];
		if (new Set(names).size !== names.length) return yield* invalid;
		const grantType = params.get("grant_type");
		if (grantType === null) return yield* invalid;
		if (grantType !== "authorization_code") return yield* new TokenError({ error: "unsupported_grant_type" });
		const code = params.get("code");
		const redirectUri = params.get("redirect_uri");
		const clientId = params.get("client_id");
		const verifier = params.get("code_verifier");
		if (code === null || redirectUri === null || clientId === null || verifier === null) return yield* invalid;
		return yield* issuer.redeem({ code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
	}).pipe(
		Effect.map((tokens) => HttpServerResponse.jsonUnsafe(tokens, { headers: noStore })),
		Effect.catchTag("TokenError", (error) =>
			Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.error }, { status: 400, headers: noStore })),
		),
	);
});
