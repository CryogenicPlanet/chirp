import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { Settings } from "./settings.ts";

export const providers = ["github", "google"] as const;
export type Provider = (typeof providers)[number];

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
	provider: Schema.Literals(providers),
	step: Schema.Literals(["token", "user"]),
}) {}

export type Endpoints = Readonly<
	Record<Provider, { readonly authorize: string; readonly token: string; readonly user: string }>
>;
export const productionEndpoints: Endpoints = {
	github: {
		authorize: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		user: "https://api.github.com/user",
	},
	google: {
		authorize: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		user: "https://openidconnect.googleapis.com/v1/userinfo",
	},
};

/** The upstream account. `sub` is the stable identifier; `username` and `email` are display labels only. */
export const Identity = Schema.Struct({
	provider: Schema.Literals(providers),
	sub: Schema.String,
	username: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String),
});
export type Identity = typeof Identity.Type;

const AccessToken = Schema.Struct({ access_token: Schema.NonEmptyString });
// GitHub answers a refused exchange with 200 and {error}, which this schema rejects.
const GitHubUser = Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)), login: Schema.NonEmptyString });
// Google documents email_verified as a boolean but has shown it as the string "true".
const GoogleUser = Schema.Struct({
	sub: Schema.NonEmptyString,
	email: Schema.optionalKey(Schema.String),
	email_verified: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
});

/** Hand-rolled GitHub OAuth app and Google OpenID Connect web flows, both with PKCE S256. */
const make = (endpoints: Endpoints) =>
	Effect.gen(function* () {
		const settings = yield* Settings;
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
		const callback = (provider: Provider) => `${settings.issuer}/callback/${provider}`;
		// Failures carry only the provider and step: request bodies hold the client secret and the code.
		const json =
			<A, I>(provider: Provider, step: "token" | "user", schema: Schema.Codec<A, I>) =>
			(request: HttpClientRequest.HttpClientRequest) =>
				client.execute(request).pipe(
					Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
					Effect.timeoutOrElse({
						duration: "10 seconds",
						orElse: () => Effect.fail(new UpstreamError({ provider, step })),
					}),
					Effect.mapError(() => new UpstreamError({ provider, step })),
				);

		/**
		 * GitHub needs no scope to read the public profile; Google needs `openid email`. No nonce goes upstream: the
		 * identity comes from the user endpoint over TLS, never from an upstream ID token.
		 */
		const authorizeUrl = (provider: Provider, params: { state: string; challenge: string }) => {
			const url = new URL(endpoints[provider].authorize);
			const query: Record<string, string> = {
				client_id: settings[provider].clientId,
				redirect_uri: callback(provider),
				state: params.state,
				code_challenge: params.challenge,
				code_challenge_method: "S256",
				...(provider === "google" ? { response_type: "code", scope: "openid email" } : {}),
			};
			for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
			return url.href;
		};

		const exchange = (provider: Provider, code: string, verifier: string) =>
			HttpClientRequest.post(endpoints[provider].token).pipe(
				HttpClientRequest.acceptJson,
				HttpClientRequest.bodyUrlParams({
					client_id: settings[provider].clientId,
					client_secret: Redacted.value(settings[provider].clientSecret),
					code,
					redirect_uri: callback(provider),
					code_verifier: verifier,
					...(provider === "google" ? { grant_type: "authorization_code" } : {}),
				}),
				json(provider, "token", AccessToken),
			);

		/** Finish the upstream sign-in. GitHub's subject is the numeric account id, never the renameable login. */
		const identify = (provider: Provider, code: string, verifier: string) =>
			Effect.gen(function* () {
				const token = yield* exchange(provider, code, verifier);
				const request = HttpClientRequest.get(endpoints[provider].user).pipe(
					HttpClientRequest.bearerToken(token.access_token),
				);
				if (provider === "github") {
					const user = yield* request.pipe(
						HttpClientRequest.setHeaders({
							accept: "application/vnd.github+json",
							"user-agent": "chirp-signin",
							"x-github-api-version": "2022-11-28",
						}),
						json(provider, "user", GitHubUser),
					);
					return { provider, sub: `github:${user.id}`, username: user.login } satisfies Identity;
				}
				const user = yield* request.pipe(HttpClientRequest.acceptJson, json(provider, "user", GoogleUser));
				const verified = user.email_verified === true || user.email_verified === "true";
				return {
					provider,
					sub: `google:${user.sub}`,
					...(verified && user.email ? { email: user.email } : {}),
				} satisfies Identity;
			});

		return { authorizeUrl, identify } as const;
	});

export class Upstream extends Context.Service<Upstream, Effect.Success<ReturnType<typeof make>>>()(
	"comms/signin/Upstream",
) {}

export const layer = (endpoints: Endpoints = productionEndpoints) => Layer.effect(Upstream, make(endpoints));
