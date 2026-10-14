import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { boardRedirect, issuer, signIn, token, withHarness } from "./fixtures/signin.ts";

it(
	"serves the discovery document of the shared contract",
	withHarness(async (h) => {
		const response = await h.request("/.well-known/openid-configuration");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
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
			chirp_providers: ["github", "google"],
		});
		const keys = await (await h.request("/jwks.json")).json();
		expect(keys).toEqual({
			keys: [
				{
					kty: "EC",
					crv: "P-256",
					x: expect.any(String),
					y: expect.any(String),
					kid: "test-key",
					alg: "ES256",
					use: "sig",
				},
			],
		});
		expect(JSON.stringify(keys)).not.toContain('"d"');
		expect((await h.request("/health")).status).toBe(200);
		expect(await (await h.request("/")).text()).toContain("POST /token - ");
	}),
);

it.each([
	["github", { preferred_username: "octocat" }, "github:4242"],
	["google", { email: "person@example.com" }, "google:1098765"],
] as const)(
	"signs in end to end through %s and the ID token verifies as boot verifies it",
	withHarness(async (h, provider: "github" | "google", label: Record<string, string>, subject: string) => {
		const discovery = await (await h.request("/.well-known/openid-configuration")).json();
		const signedIn = await signIn(h, provider);
		expect(signedIn.consent.status).toBe(303);
		expect(`${signedIn.back.origin}${signedIn.back.pathname}`).toBe(boardRedirect);
		expect(signedIn.back.searchParams.get("state")).toBe("board-state");
		expect(signedIn.back.searchParams.get("iss")).toBe(discovery.issuer);
		expect(signedIn.consent.headers.getSetCookie().join()).toMatch(/__Host-signin\.tx=;.*Max-Age=0/);

		const exchanged = await token(h, {
			grant_type: "authorization_code",
			code: signedIn.code,
			redirect_uri: boardRedirect,
			client_id: signedIn.clientId,
			code_verifier: signedIn.boardVerifier,
		});
		expect(exchanged.status).toBe(200);
		expect(exchanged.headers.get("cache-control")).toBe("no-store");
		const tokens = await exchanged.json();
		expect(tokens).toEqual({
			id_token: expect.any(String),
			access_token: expect.any(String),
			token_type: "Bearer",
			expires_in: 300,
		});

		// Boot's relying-party check: JWKS from jwks_uri, an algorithm allowlist, iss, aud, azp, nonce and time.
		const jwks = createLocalJWKSet(await (await h.request(new URL(discovery.jwks_uri).pathname)).json());
		const { payload, protectedHeader } = await jwtVerify(tokens.id_token, jwks, {
			issuer: discovery.issuer,
			audience: signedIn.clientId,
			algorithms: ["ES256", "EdDSA", "RS256"],
			clockTolerance: 60,
			requiredClaims: ["iss", "aud", "sub", "iat", "exp", "nonce"],
		});
		expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "test-key", typ: "JWT" });
		expect(payload.azp).toBe(signedIn.clientId);
		expect(payload.nonce).toBe("board-nonce");
		expect(payload.sub).toBe(subject);
		expect(payload.chirp_provider).toBe(provider);
		expect(payload).toMatchObject(label);
		expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
		expect(Number(payload.auth_time)).toBeLessThanOrEqual(Number(payload.iat));
		expect(decodeProtectedHeader(tokens.id_token).alg).toBe("ES256");
	}),
);
