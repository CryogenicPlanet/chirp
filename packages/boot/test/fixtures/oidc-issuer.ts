// A loopback stand-in for auth.chirp.wiki on node:http, so Bun fixtures and Node tests share one issuer.
/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose";

export interface SigningKey {
	readonly kid: string;
	readonly privateKey: CryptoKey;
	readonly publicJwk: JWK;
}
export const signingKey = async (kid: string): Promise<SigningKey> => {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } };
};
export const sign = (payload: JWTPayload, key: SigningKey) =>
	new SignJWT(payload).setProtectedHeader({ alg: "ES256", kid: key.kid }).sign(key.privateKey);

/** What the human signed in as upstream, and how this test bends the issued token. */
export interface Grant {
	readonly subject: string;
	readonly provider: "github" | "google";
	readonly label?: string;
	readonly claims?: (payload: JWTPayload) => JWTPayload;
	readonly mint?: (payload: JWTPayload) => Promise<string>;
}

export const fakeIssuer = async () => {
	const key = await signingKey("k1");
	const published: JWK[] = [key.publicJwk];
	const counts = { discovery: 0, jwks: 0, token: 0, moved: 0 };
	const modes: {
		discovery: "ok" | "stall" | "mismatch" | "offorigin" | "userinfo" | "redirect" | "large" | "html";
		jwks: "ok" | "large" | "html";
		token: "ok" | "stall" | "error" | "html" | "refuse";
		reuse: boolean;
	} = {
		discovery: "ok",
		jwks: "ok",
		token: "ok",
		reuse: false,
	};
	const codes = new Map<
		string,
		{
			readonly clientId: string;
			readonly redirectUri: string;
			readonly challenge: string;
			readonly nonce: string;
			readonly grant: Grant;
		}
	>();
	const held: ServerResponse[] = [];
	let base = "";
	const json = (response: ServerResponse, status: number, value: unknown) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	const html = (response: ServerResponse) => {
		response.writeHead(200, { "content-type": "text/html" });
		response.end("<html>maintenance</html>");
	};
	// Valid JSON, but past the 64 KiB a relying party should ever read.
	const padding = "x".repeat(70 * 1024);
	const discovery = () => {
		const port = new URL(base).port;
		return {
			issuer: modes.discovery === "mismatch" ? "https://auth.chirp.wiki" : base,
			authorization_endpoint: `${base}/authorize`,
			token_endpoint:
				modes.discovery === "offorigin"
					? "https://evil.test/token"
					: modes.discovery === "userinfo"
						? `http://user:secret@localhost:${port}/token`
						: `${base}/token`,
			jwks_uri: `${base}/jwks.json`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			id_token_signing_alg_values_supported: ["ES256"],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
			chirp_providers: ["github", "google"],
			...(modes.discovery === "large" ? { padding } : {}),
		};
	};
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", base);
		if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
			counts.discovery++;
			if (modes.discovery === "stall") return void held.push(response);
			if (modes.discovery === "html") return html(response);
			if (modes.discovery === "redirect") {
				response.writeHead(302, { location: `${base}/moved/.well-known/openid-configuration` });
				return void response.end();
			}
			return json(response, 200, discovery());
		}
		// Where a redirected discovery would lead, if a relying party followed it.
		if (request.method === "GET" && url.pathname === "/moved/.well-known/openid-configuration") {
			counts.moved++;
			return json(response, 200, { ...discovery(), issuer: base });
		}
		if (request.method === "GET" && url.pathname === "/jwks.json") {
			counts.jwks++;
			if (modes.jwks === "html") return html(response);
			return json(response, 200, { keys: published, ...(modes.jwks === "large" ? { padding } : {}) });
		}
		if (request.method === "POST" && url.pathname === "/token") {
			counts.token++;
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				if (modes.token === "stall") return void held.push(response);
				if (modes.token === "error") return json(response, 503, { error: "temporarily_unavailable" });
				if (modes.token === "html") return html(response);
				const form = new URLSearchParams(body);
				const code = codes.get(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				if (
					modes.token === "refuse" ||
					!code ||
					form.get("grant_type") !== "authorization_code" ||
					form.get("client_id") !== code.clientId ||
					form.get("redirect_uri") !== code.redirectUri ||
					createHash("sha256").update(verifier).digest("base64url") !== code.challenge
				)
					return json(response, 400, { error: "invalid_grant" });
				if (!modes.reuse) codes.delete(form.get("code") ?? "");
				const now = Math.floor(Date.now() / 1000);
				const grant = code.grant;
				const payload = (grant.claims ?? ((value) => value))({
					iss: base,
					aud: code.clientId,
					azp: code.clientId,
					sub: grant.subject,
					iat: now,
					exp: now + 300,
					auth_time: now,
					nonce: code.nonce,
					chirp_provider: grant.provider,
					...(grant.provider === "github"
						? { preferred_username: grant.label ?? "octocat" }
						: { email: grant.label ?? "human@example.com" }),
				});
				void (grant.mint ?? ((value) => sign(value, key)))(payload).then((token) =>
					json(response, 200, { id_token: token, access_token: "opaque", token_type: "Bearer", expires_in: 300 }),
				);
			});
			return;
		}
		json(response, 404, { error: "not_found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Issuer is not listening");
	// Boot accepts plain http only for localhost; Bun resolves it to this loopback listener.
	base = `http://localhost:${address.port}`;
	return {
		issuer: base,
		key,
		counts,
		modes,
		/** Make a new key the published set serves from now on. */
		publish: (jwk: JWK) => {
			published.push(jwk);
		},
		/** Answer every held request so nothing outlives the test. */
		release: () => {
			for (const response of held.splice(0)) json(response, 503, { error: "released" });
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const response of held.splice(0)) response.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
		/** What /authorize and consent would do: check the request and hand back the callback the browser follows. */
		issue: (authorizationUrl: string, grant: Grant) => {
			const request = new URL(authorizationUrl);
			const parameter = (name: string) => {
				const value = request.searchParams.get(name);
				if (value === null) throw new Error(`Missing ${name}`);
				return value;
			};
			if (
				request.origin !== base ||
				request.pathname !== "/authorize" ||
				parameter("response_type") !== "code" ||
				parameter("scope") !== "openid" ||
				parameter("code_challenge_method") !== "S256"
			)
				throw new Error(`Unexpected authorization request ${authorizationUrl}`);
			const code = randomBytes(24).toString("base64url");
			codes.set(code, {
				clientId: parameter("client_id"),
				redirectUri: parameter("redirect_uri"),
				challenge: parameter("code_challenge"),
				nonce: parameter("nonce"),
				grant,
			});
			const callback = new URL(parameter("redirect_uri"));
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", parameter("state"));
			callback.searchParams.set("iss", base);
			return {
				code,
				state: parameter("state"),
				provider: request.searchParams.get("provider"),
				clientId: parameter("client_id"),
				callback: callback.href,
			};
		},
	};
};
export type FakeIssuer = Awaited<ReturnType<typeof fakeIssuer>>;
