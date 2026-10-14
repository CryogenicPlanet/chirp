import { Clock, DateTime, Effect, Ref, Result, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { AuthError } from "./auth.ts";
import { OidcProvider } from "./oidc-schema.ts";

/** A chirp sign-in issuer (auth.chirp.wiki or another deployment of packages/signin), read from boot's own
 * environment. Absent when OIDC_ISSUER=none. The board is always its own client, named by its metadata document. */
export interface OidcConfig {
	readonly issuer: string;
}

/** An exact origin: https, or http only for localhost, with no path, not even a trailing slash. Tokens name the
 * issuer exactly, so anything else would start and then fail every sign-in. */
export const validIssuer = (issuer: string) => {
	const url = issuer.length <= 512 ? URL.parse(issuer) : null;
	return (
		url !== null &&
		url.origin === issuer &&
		(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))
	);
};
/** Discovery may name endpoints elsewhere, but plain http only when the issuer itself is a localhost issuer, so a
 * hostile document cannot send the code and verifier to a service on the board's own host. */
const validEndpoint = (endpoint: string, issuer: string) => {
	const url = URL.parse(endpoint);
	return (
		url !== null &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" && url.hostname === "localhost" && issuer.startsWith("http:"))) &&
		!url.username &&
		!url.password &&
		!url.hash
	);
};

const Discovery = Schema.Struct({
	issuer: Schema.String,
	authorization_endpoint: Schema.String,
	token_endpoint: Schema.String,
	jwks_uri: Schema.String,
	chirp_providers: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Discovery = typeof Discovery.Type;
// Only public members reach the verifier; jose refuses anything that is not a public key.
const Jwk = Schema.Struct({
	kty: Schema.String,
	kid: Schema.optionalKey(Schema.String),
	alg: Schema.optionalKey(Schema.String),
	use: Schema.optionalKey(Schema.String),
	key_ops: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
	ext: Schema.optionalKey(Schema.Boolean),
	crv: Schema.optionalKey(Schema.String),
	x: Schema.optionalKey(Schema.String),
	y: Schema.optionalKey(Schema.String),
	n: Schema.optionalKey(Schema.String),
	e: Schema.optionalKey(Schema.String),
});
const Jwks = Schema.Struct({ keys: Schema.mutable(Schema.Array(Jwk)) });
const TokenResponse = Schema.Struct({ id_token: Schema.String });
const Claims = Schema.Struct({
	sub: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
	nonce: Schema.String,
	aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
	azp: Schema.optionalKey(Schema.String),
	chirp_provider: OidcProvider,
	preferred_username: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String),
});

/** Verified identity claims. Identities match by issuer and subject; the label is only shown. */
export interface OidcIdentity {
	readonly issuer: string;
	readonly subject: string;
	readonly provider: OidcProvider;
	readonly label: string;
}

const timeout = "5 seconds";
const maxBytes = 64 * 1024;
const cacheMs = 10 * 60_000;
// Never none or an HMAC: a public verifier holds no shared secret.
const algorithms: ReadonlyArray<string> = Object.freeze(["ES256", "EdDSA", "RS256"]);
const invalid = () => new AuthError({ code: "oidc_invalid" });
const unavailable = () => new AuthError({ code: "oidc_unavailable" });

/** One bounded request to the sign-in service: no redirects, 5 seconds, at most 64 KiB of JSON. A 4xx from the token
 * endpoint is a refused code; every other failure is the service being unavailable. */
const exchangeJson = <A>(
	request: HttpClientRequest.HttpClientRequest,
	schema: Schema.ConstraintDecoder<A>,
	refusable = false,
) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.execute(request)
			.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
		if (refusable && response.status >= 400 && response.status < 500) return yield* invalid();
		if (response.status !== 200) return yield* unavailable();
		const chunks = yield* Stream.runFoldEffect(
			response.stream,
			(): ReadonlyArray<Uint8Array> => [],
			(received, chunk) =>
				received.reduce((total, part) => total + part.length, chunk.length) > maxBytes
					? Effect.fail(unavailable())
					: Effect.succeed([...received, chunk]),
		);
		return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(Buffer.concat(chunks)));
	}).pipe(
		Effect.timeout(timeout),
		Effect.mapError((error) => (Schema.is(AuthError)(error) ? error : unavailable())),
	);

/** Discovery and keys are cached in this Ref, owned by the Auth instance. Every call here is network I/O, so callers
 * never hold the auth mutex or a SQL transaction across one. */
export const makeOidcClient = (config: OidcConfig, clientId: string) =>
	Effect.gen(function* () {
		const cache = yield* Ref.make<{
			readonly discovery: Discovery;
			readonly keys: JSONWebKeySet | null;
			readonly expiresAt: number;
		} | null>(null);
		const discovery = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const cached = yield* Ref.get(cache);
			if (cached !== null && cached.expiresAt > now) return cached.discovery;
			const fetched = yield* exchangeJson(
				HttpClientRequest.get(`${config.issuer}/.well-known/openid-configuration`).pipe(HttpClientRequest.acceptJson),
				Discovery,
			);
			if (
				fetched.issuer !== config.issuer ||
				![fetched.authorization_endpoint, fetched.token_endpoint, fetched.jwks_uri].every((endpoint) =>
					validEndpoint(endpoint, config.issuer),
				)
			)
				return yield* unavailable();
			yield* Ref.set(cache, { discovery: fetched, keys: null, expiresAt: now + cacheMs });
			return fetched;
		});
		const keys = (refresh: boolean) =>
			Effect.gen(function* () {
				const published = yield* discovery;
				const cached = yield* Ref.get(cache);
				if (!refresh && cached?.discovery === published && cached.keys !== null) return cached.keys;
				const fetched: JSONWebKeySet = yield* exchangeJson(
					HttpClientRequest.get(published.jwks_uri).pipe(HttpClientRequest.acceptJson),
					Jwks,
				);
				yield* Ref.update(cache, (current) =>
					current?.discovery === published ? { ...current, keys: fetched } : current,
				);
				return fetched;
			});
		const verify = (token: string, nonce: string) =>
			Effect.gen(function* () {
				const now = yield* DateTime.nowAsDate;
				const attempt = (set: JSONWebKeySet) =>
					Effect.tryPromise({
						try: () =>
							jwtVerify(token, createLocalJWKSet(set), {
								issuer: config.issuer,
								audience: clientId,
								algorithms: [...algorithms],
								clockTolerance: 60,
								maxTokenAge: 300,
								requiredClaims: ["exp", "iat", "sub", "nonce"],
								currentDate: now,
							}),
						catch: (error) => (error instanceof errors.JWKSNoMatchingKey ? "unknown_key" : "invalid"),
					}).pipe(Effect.result);
				const first = yield* attempt(yield* keys(false));
				// A key the service rotated in since the last fetch earns exactly one refetch.
				const verified =
					Result.isFailure(first) && first.failure === "unknown_key" ? yield* attempt(yield* keys(true)) : first;
				if (Result.isFailure(verified)) return yield* invalid();
				const payload: JWTPayload = verified.success.payload;
				const claims = yield* Schema.decodeUnknownEffect(Claims)(payload).pipe(Effect.mapError(invalid));
				const nonceMatches = claims.nonce.length === nonce.length && claims.nonce === nonce;
				// azp must name this board; several audiences without it could be a token meant for another client.
				const presenter =
					claims.azp === undefined
						? typeof claims.aud === "string" || claims.aud.length === 1
						: claims.azp === clientId;
				if (!nonceMatches || !presenter) return yield* invalid();
				const label = (claims.preferred_username ?? claims.email ?? claims.sub)
					// oxlint-disable-next-line no-control-regex -- control characters are exactly what a shown label drops.
					.replace(/[\u0000-\u001f\u007f]/g, "")
					.slice(0, 128);
				const identity: OidcIdentity = {
					issuer: config.issuer,
					subject: claims.sub,
					provider: claims.chirp_provider,
					label,
				};
				return identity;
			});
		return {
			clientId,
			/** The providers the service lists, or null when it lists none, which leaves every provider boot knows. */
			providers: Effect.map(discovery, (published) => published.chirp_providers ?? null),
			/** The same from the last discovery, without asking the service again; null when nothing is cached. */
			cachedProviders: Effect.map(Ref.get(cache), (cached) => cached?.discovery.chirp_providers ?? null),
			authorizationUrl: (params: Readonly<Record<string, string>>) =>
				Effect.map(discovery, (published) => {
					const url = new URL(published.authorization_endpoint);
					for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
					return url.href;
				}),
			/** Redeem a code with its PKCE verifier and verify the ID token it returns. */
			exchange: (code: string, verifier: string, redirectUri: string, nonce: string) =>
				Effect.gen(function* () {
					const published = yield* discovery;
					const response = yield* exchangeJson(
						HttpClientRequest.post(published.token_endpoint).pipe(
							HttpClientRequest.acceptJson,
							HttpClientRequest.bodyUrlParams({
								grant_type: "authorization_code",
								code,
								redirect_uri: redirectUri,
								client_id: clientId,
								code_verifier: verifier,
							}),
						),
						TokenResponse,
						true,
					);
					return yield* verify(response.id_token, nonce);
				}),
		};
	});
