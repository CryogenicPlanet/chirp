import { BunCrypto } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { type Crypto, Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { expect, it as vitest } from "vitest";
import * as Issuer from "../src/issuer.ts";
import { seal } from "../src/seal.ts";
import * as Settings from "../src/settings.ts";
import type { Identity } from "../src/upstream.ts";
import { boardRedirect, rawSettings, s256, signIn, token, verifier, withHarness } from "./fixtures/signin.ts";

const clientId = "https://board.test/auth/oidc/client.json";
const octocat: Identity = { provider: "github", sub: "github:4242", username: "octocat" };

/** The issuer over fresh keys. Effects run under the test clock, so time only moves when a test adjusts it. */
const withIssuer = <A, E>(
	body: (
		issuer: Issuer.Issuer["Service"],
		settings: Settings.Settings["Service"],
	) => Effect.Effect<A, E, Crypto.Crypto>,
) =>
	Effect.gen(function* () {
		const raw = yield* Effect.promise(rawSettings);
		return yield* Effect.gen(function* () {
			return yield* body(yield* Issuer.Issuer, yield* Settings.Settings);
		}).pipe(
			Effect.provide(Issuer.layer.pipe(Layer.provideMerge(Settings.fromRaw(raw)), Layer.provideMerge(BunCrypto.layer))),
		);
	});

const issue = (issuer: Issuer.Issuer["Service"], challenge: string, identity: Identity = octocat) =>
	issuer.issueCode({
		client_id: clientId,
		redirect_uri: boardRedirect,
		code_challenge: challenge,
		nonce: "board-nonce",
		auth_time: 0,
		identity,
	});
const refusal = <A>(effect: Effect.Effect<A, Issuer.TokenError>) =>
	effect.pipe(
		Effect.map(() => "issued"),
		Effect.catchTag("TokenError", (error) => Effect.succeed(error.error)),
	);

it.effect("redeems a code once, and only with its verifier, client_id and redirect_uri", () =>
	withIssuer((issuer) =>
		Effect.gen(function* () {
			const boardVerifier = verifier();
			const code = yield* issue(issuer, s256(boardVerifier));
			const request = { code, client_id: clientId, redirect_uri: boardRedirect, code_verifier: boardVerifier };
			// Failed attempts do not consume the code: PKCE, not first use, protects it.
			expect(yield* refusal(issuer.redeem({ ...request, code_verifier: verifier() }))).toBe("invalid_grant");
			expect(yield* refusal(issuer.redeem({ ...request, code_verifier: "short" }))).toBe("invalid_request");
			expect(yield* refusal(issuer.redeem({ ...request, client_id: "https://evil.test/client.json" }))).toBe(
				"invalid_grant",
			);
			expect(yield* refusal(issuer.redeem({ ...request, redirect_uri: "https://board.test/other" }))).toBe(
				"invalid_grant",
			);
			expect(yield* refusal(issuer.redeem(request))).toBe("issued");
			expect(yield* refusal(issuer.redeem(request))).toBe("invalid_grant");
		}),
	),
);

it.effect("expires a code after 60 seconds", () =>
	withIssuer((issuer) =>
		Effect.gen(function* () {
			const boardVerifier = verifier();
			const request = { client_id: clientId, redirect_uri: boardRedirect, code_verifier: boardVerifier };
			const live = yield* issue(issuer, s256(boardVerifier));
			const stale = yield* issue(issuer, s256(boardVerifier));
			yield* TestClock.adjust("59999 millis");
			expect(yield* refusal(issuer.redeem({ ...request, code: live }))).toBe("issued");
			yield* TestClock.adjust("1 millis");
			expect(yield* refusal(issuer.redeem({ ...request, code: stale }))).toBe("invalid_grant");
		}),
	),
);

it.effect("refuses tampered codes and sealed values of another purpose", () =>
	withIssuer((issuer, settings) =>
		Effect.gen(function* () {
			const boardVerifier = verifier();
			const code = yield* issue(issuer, s256(boardVerifier));
			const request = { client_id: clientId, redirect_uri: boardRedirect, code_verifier: boardVerifier };
			const flipped = `${code.slice(0, 20)}${code[20] === "A" ? "B" : "A"}${code.slice(21)}`;
			expect(yield* refusal(issuer.redeem({ ...request, code: flipped }))).toBe("invalid_grant");
			expect(yield* refusal(issuer.redeem({ ...request, code: `${code}A` }))).toBe("invalid_grant");
			expect(yield* refusal(issuer.redeem({ ...request, code: "not a code" }))).toBe("invalid_grant");
			const transaction = yield* seal(settings.sealKey, "transaction", Schema.Unknown, { code });
			expect(yield* refusal(issuer.redeem({ ...request, code: transaction }))).toBe("invalid_grant");
			expect(yield* refusal(issuer.redeem({ ...request, code }))).toBe("issued");
		}),
	),
);

it.effect.each([
	["GitHub", octocat, { preferred_username: "octocat" }, ["email"]],
	[
		"verified Google",
		{ provider: "google", sub: "google:1098765", email: "person@example.com" },
		{ email: "person@example.com" },
		["preferred_username"],
	],
	["unverified Google", { provider: "google", sub: "google:1098765" }, {}, ["email", "preferred_username"]],
] as const)("issues an ES256 ID token with the contract claims for %s", ([, identity, label, absent]) =>
	withIssuer((issuer) =>
		Effect.gen(function* () {
			yield* TestClock.setTime(1_800_000_000_000);
			const boardVerifier = verifier();
			const code = yield* issue(issuer, s256(boardVerifier), identity);
			const tokens = yield* issuer.redeem({
				code,
				client_id: clientId,
				redirect_uri: boardRedirect,
				code_verifier: boardVerifier,
			});
			expect(decodeProtectedHeader(tokens.id_token)).toEqual({ alg: "ES256", kid: "test-key", typ: "JWT" });
			const claims = decodeJwt(tokens.id_token);
			expect(claims).toEqual({
				iss: issuer.discovery.issuer,
				aud: clientId,
				azp: clientId,
				sub: identity.sub,
				iat: 1_800_000_000,
				exp: 1_800_000_300,
				nonce: "board-nonce",
				auth_time: 0,
				chirp_provider: identity.provider,
				...label,
			});
			for (const claim of absent) expect(claims).not.toHaveProperty(claim);
			expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 300 });
		}),
	),
);

vitest(
	"refuses malformed token requests with RFC 6749 errors",
	withHarness(async (h) => {
		const { code, clientId: board, boardVerifier } = await signIn(h);
		const valid = {
			grant_type: "authorization_code",
			code,
			redirect_uri: boardRedirect,
			client_id: board,
			code_verifier: boardVerifier,
		};
		const refused = async (response: Response) => {
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
			return (await response.json()).error;
		};
		expect(await refused(await token(h, valid, "application/json"))).toBe("invalid_request");
		expect(await refused(await token(h, { ...valid, grant_type: "refresh_token" }))).toBe("unsupported_grant_type");
		const { code_verifier: _verifier, ...missing } = valid;
		expect(await refused(await token(h, missing))).toBe("invalid_request");
		const duplicated = await h.request("/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `${new URLSearchParams(valid)}&client_id=${encodeURIComponent("https://evil.test/c.json")}`,
		});
		expect(await refused(duplicated)).toBe("invalid_request");
		// None of those consumed the code.
		expect((await token(h, valid)).status).toBe(200);
	}),
);

vitest(
	"lets exactly one of two concurrent exchanges of the same code succeed",
	withHarness(async (h) => {
		const { code, clientId: board, boardVerifier } = await signIn(h);
		const valid = {
			grant_type: "authorization_code",
			code,
			redirect_uri: boardRedirect,
			client_id: board,
			code_verifier: boardVerifier,
		};
		const results = await Promise.all([token(h, valid), token(h, valid), token(h, valid)]);
		expect(results.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 400, 400]);
	}),
);
