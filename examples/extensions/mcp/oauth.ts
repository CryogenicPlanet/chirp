import { on } from "@comms/storage/dialect";
import { Clock, Crypto, Effect, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Api, ManagedRequestContext } from "../../../packages/server/src/kernel/extension-api.ts";

const ClientInput = Schema.Struct({
	client_name: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
	token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});
const Stored = Schema.Struct({
	id: Schema.String,
	kind: Schema.String,
	client_id: Schema.String,
	family: Schema.String,
	payload: Schema.String,
	expires_at: Schema.Finite,
	created_at: Schema.Finite,
});
const Client = Schema.Struct({
	client_name: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
});
const Grant = Schema.Struct({
	redirect_uri: Schema.String,
	code_challenge: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.Union([Schema.Literal("read"), Schema.Literal("write")])),
	subject: Schema.String,
});
const Access = Schema.Struct({
	resource: Schema.String,
	scopes: Schema.Array(Schema.Union([Schema.Literal("read"), Schema.Literal("write")])),
	subject: Schema.String,
});

type Context = ManagedRequestContext;
export interface OAuthIdentity {
	readonly clientId: string;
	readonly subject: string;
	readonly scopes: ReadonlyArray<"read" | "write">;
}
const bodyLimit = 16384;
const escape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
	);
const oauthError = (error: string, description: string, status = 400) =>
	Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });
const redirect = (uri: string, fields: Readonly<Record<string, string>>) => {
	const target = new URL(uri);
	for (const [name, value] of Object.entries(fields)) target.searchParams.set(name, value);
	return new Response(null, {
		status: 302,
		headers: { location: target.href, "cache-control": "no-store" },
	});
};
const one = (value: string | ReadonlyArray<string> | undefined) => (typeof value === "string" ? value : undefined);
const scopes = (value: string | undefined) => {
	const requested = value?.split(" ").filter(Boolean) ?? ["read"];
	const accepted: Array<"read" | "write"> = [];
	for (const scope of requested) {
		if (scope !== "read" && scope !== "write") return null;
		if (!accepted.includes(scope)) accepted.push(scope);
	}
	return accepted.includes("read") ? accepted : null;
};
const validRedirect = (value: string) => {
	try {
		const url = new URL(value);
		return (
			!url.hash &&
			!url.username &&
			!url.password &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
		);
	} catch {
		return false;
	}
};
const boundedText = (
	request: Parameters<Api["route"]>[2]["handler"] extends (request: infer R, ...rest: never[]) => unknown ? R : never,
) =>
	Effect.gen(function* () {
		let bytes = 0;
		const read = yield* request.stream.pipe(
			Stream.tap((chunk) =>
				Effect.try(() => {
					bytes += chunk.byteLength;
					if (bytes > bodyLimit) throw new Error("body too large");
				}),
			),
			Stream.runCollect,
			Effect.map((chunks) => Buffer.concat(chunks).toString("utf8")),
			Effect.timeout("5 seconds"),
			Effect.result,
		);
		return read._tag === "Success" ? read.success : null;
	});
const digest = (crypto: Crypto.Crypto, value: string) =>
	crypto
		.digest("SHA-256", new TextEncoder().encode(value))
		.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
const random = (crypto: Crypto.Crypto, prefix: string, size = 32) =>
	crypto.randomBytes(size).pipe(Effect.map((bytes) => prefix + Buffer.from(bytes).toString("base64url")));
const lookup = (ctx: Context, id: string, kind: string) =>
	ctx.db`SELECT id,kind,client_id,family,payload,expires_at,created_at FROM example_mcp_oauth WHERE id=${id} AND kind=${kind}`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Stored))),
		Effect.map((rows) => rows[0]),
	);
const client = (ctx: Context, clientId: string) =>
	lookup(ctx, clientId, "client").pipe(
		Effect.flatMap((row) =>
			row
				? Schema.decodeEffect(Schema.fromJsonString(Client))(row.payload)
				: Effect.succeed<typeof Client.Type | undefined>(undefined),
		),
	);
const store = (
	ctx: Context,
	row: {
		readonly id: string;
		readonly kind: string;
		readonly clientId: string;
		readonly family: string;
		readonly payload: string;
		readonly expires: number;
	},
) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		yield* ctx.db`INSERT INTO example_mcp_oauth(id,kind,client_id,family,payload,expires_at,created_at) VALUES(${row.id},${row.kind},${row.clientId},${row.family},${row.payload},${row.expires},${now})`;
	});
const authorizeInput = (query: Context["query"]) => ({
	clientId: one(query.client_id),
	redirectUri: one(query.redirect_uri),
	state: one(query.state),
	challenge: one(query.code_challenge),
	challengeMethod: one(query.code_challenge_method),
	responseType: one(query.response_type),
	resource: one(query.resource),
	scopes: scopes(one(query.scope)),
});
/** Returns the checked request, or names the first failed check so the person at the consent page can fix the client. */
const authorization = (ctx: Context, query: Context["query"], resource: string) =>
	Effect.gen(function* () {
		const input = authorizeInput(query);
		const registered = input.clientId ? yield* client(ctx, input.clientId) : undefined;
		if (!input.clientId || !registered) return "client_id is not registered with this board.";
		if (!input.redirectUri || !registered.redirect_uris.includes(input.redirectUri))
			return "redirect_uri is not registered for this client.";
		if (input.responseType !== "code") return "response_type must be code.";
		if (input.resource !== resource) return `resource must be ${resource}; connect the client to exactly that URL.`;
		if (input.state !== undefined && input.state.length > 2048) return "state must be at most 2048 characters.";
		if (input.challengeMethod !== "S256" || !input.challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(input.challenge))
			return "code_challenge must be an S256 PKCE challenge.";
		if (!input.scopes) return "scope must be read, optionally with write.";
		return {
			clientId: input.clientId,
			clientName: registered.client_name,
			redirectUri: input.redirectUri,
			challenge: input.challenge,
			scopes: input.scopes,
			state: input.state,
		};
	});

export const installOAuth = (api: Api, origin: string, resourceOrigin = origin) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const resource = `${resourceOrigin}/mcp`;
		yield* api.migrate(
			"oauth_credentials",
			on(sql, {
				sqlite: () =>
					"CREATE TABLE example_mcp_oauth(id TEXT PRIMARY KEY,kind TEXT NOT NULL,client_id TEXT NOT NULL,family TEXT NOT NULL,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)",
				pg: () =>
					"CREATE TABLE example_mcp_oauth(id TEXT PRIMARY KEY,kind TEXT NOT NULL,client_id TEXT NOT NULL,family TEXT NOT NULL,payload TEXT NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL)",
				mysql: () =>
					"CREATE TABLE example_mcp_oauth(id VARCHAR(128) PRIMARY KEY,kind VARCHAR(16) NOT NULL,client_id VARCHAR(128) NOT NULL,family VARCHAR(64) NOT NULL,payload LONGTEXT NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
			}),
			{ protect: true },
		);
		api.route("GET", "/.well-known/oauth-protected-resource/mcp", {
			description: "OAuth protected-resource metadata for the optional MCP extension.",
			access: "application-managed",
			handler: () =>
				Effect.succeed(
					Response.json({
						resource,
						authorization_servers: [origin],
						bearer_methods_supported: ["header"],
						scopes_supported: ["read", "write"],
					}),
				),
		});
		api.route("GET", "/.well-known/oauth-authorization-server", {
			description: "OAuth authorization-server metadata for the optional MCP extension.",
			access: "application-managed",
			handler: () =>
				Effect.succeed(
					Response.json({
						issuer: origin,
						authorization_endpoint: `${origin}/mcp/oauth/authorize`,
						token_endpoint: `${origin}/mcp/oauth/token`,
						registration_endpoint: `${origin}/mcp/oauth/register`,
						response_types_supported: ["code"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						code_challenge_methods_supported: ["S256"],
						resource_indicators_supported: true,
						token_endpoint_auth_methods_supported: ["none"],
						scopes_supported: ["read", "write"],
					}),
				),
		});
		api.route("POST", "/mcp/oauth/register", {
			description: "Register a public OAuth client for the optional MCP extension.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
						return oauthError("invalid_client_metadata", "Content-Type must be application/json.", 415);
					const text = yield* boundedText(request);
					if (text === null) return oauthError("invalid_client_metadata", "Request body is too large or timed out.");
					const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ClientInput))(text).pipe(Effect.result);
					if (decoded._tag === "Failure") return oauthError("invalid_client_metadata", "Client metadata is invalid.");
					const input = decoded.success;
					if (
						!input.client_name.trim() ||
						input.client_name.length > 200 ||
						input.redirect_uris.length < 1 ||
						input.redirect_uris.length > 5 ||
						input.redirect_uris.some((uri) => uri.length > 2048 || !validRedirect(uri)) ||
						(input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none")
					)
						return oauthError(
							"invalid_client_metadata",
							"Use one to five HTTPS or loopback redirect URIs and no client secret.",
						);
					const clientId = yield* random(crypto, "mcp_client_", 24);
					const now = yield* Clock.currentTimeMillis;
					yield* ctx.mutate(
						store(ctx, {
							id: clientId,
							kind: "client",
							clientId,
							family: "",
							payload: yield* Schema.encodeEffect(Schema.fromJsonString(Client))({
								client_name: input.client_name.trim(),
								redirect_uris: input.redirect_uris,
							}),
							expires: 0,
						}),
					);
					return Response.json(
						{
							...input,
							client_id: clientId,
							client_id_issued_at: Math.floor(now / 1000),
							token_endpoint_auth_method: "none",
						},
						{ status: 201, headers: { "cache-control": "no-store" } },
					);
				}),
		});
		api.route("GET", "/mcp/oauth/authorize", {
			description: "Show human consent for an MCP OAuth client after passkey sign-in.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (ctx.identity?.kind !== "human")
						return new Response(null, {
							status: 302,
							headers: {
								location: `/auth/login?next=${encodeURIComponent(request.url)}`,
								"cache-control": "no-store",
							},
						});
					const checked = yield* authorization(ctx, ctx.query, resource);
					if (typeof checked === "string") return oauthError("invalid_request", checked);
					const hidden = new URLSearchParams({
						client_id: checked.clientId,
						redirect_uri: checked.redirectUri,
						code_challenge: checked.challenge,
						code_challenge_method: "S256",
						response_type: "code",
						resource,
						scope: checked.scopes.join(" "),
						...(checked.state === undefined ? {} : { state: checked.state }),
					});
					return new Response(
						`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize MCP</title></head><body><main><h1>Authorize ${escape(checked.clientName)}</h1><p>This client is requesting: ${escape(checked.scopes.join(", "))}.</p><form method="post" action="/mcp/oauth/authorize">${[...hidden].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}<button name="decision" value="approve">Authorize</button><button name="decision" value="deny">Deny</button></form></main></body></html>`,
						{
							headers: {
								"content-type": "text/html; charset=utf-8",
								"cache-control": "no-store",
								"content-security-policy":
									// Chromium applies form-action to the redirect after submit, so allow the client's callback origin.
									`default-src 'none'; form-action 'self' ${new URL(checked.redirectUri).origin}; base-uri 'none'; frame-ancestors 'none'`,
							},
						},
					);
				}),
		});
		api.route("POST", "/mcp/oauth/authorize", {
			description: "Approve or deny an MCP OAuth client after passkey sign-in.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (ctx.identity?.kind !== "human") return oauthError("access_denied", "Passkey sign-in is required.", 401);
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded")
						return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.", 415);
					const text = yield* boundedText(request);
					if (text === null) return oauthError("invalid_request", "Request body is too large or timed out.");
					const form = Object.fromEntries(new URLSearchParams(text));
					const checked = yield* authorization(ctx, form, resource);
					if (typeof checked === "string") return oauthError("invalid_request", checked);
					if (form.decision !== "approve")
						return redirect(checked.redirectUri, {
							error: "access_denied",
							...(checked.state ? { state: checked.state } : {}),
						});
					const code = yield* random(crypto, "mcp_code_");
					const codeDigest = yield* digest(crypto, code);
					const now = yield* Clock.currentTimeMillis;
					yield* ctx.mutate(
						store(ctx, {
							id: codeDigest,
							kind: "code",
							clientId: checked.clientId,
							family: "",
							payload: yield* Schema.encodeEffect(Schema.fromJsonString(Grant))({
								redirect_uri: checked.redirectUri,
								code_challenge: checked.challenge,
								resource,
								scopes: checked.scopes,
								subject: ctx.identity.agent,
							}),
							expires: now + 5 * 60 * 1000,
						}),
					);
					return redirect(checked.redirectUri, {
						code,
						...(checked.state ? { state: checked.state } : {}),
					});
				}),
		});
		api.route("POST", "/mcp/oauth/token", {
			description: "Exchange an MCP OAuth authorization code or rotate a refresh token.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded")
						return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.", 415);
					const text = yield* boundedText(request);
					if (text === null) return oauthError("invalid_request", "Request body is too large or timed out.");
					const form = Object.fromEntries(new URLSearchParams(text));
					if (form.grant_type !== "authorization_code" && form.grant_type !== "refresh_token")
						return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
					if (form.resource !== resource)
						return oauthError("invalid_target", "The token must be requested for this MCP resource.");
					const presented = form.grant_type === "authorization_code" ? form.code : form.refresh_token;
					const kind = form.grant_type === "authorization_code" ? "code" : "refresh";
					if (
						!presented ||
						!form.client_id ||
						(kind === "code" &&
							(!form.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier) || !form.redirect_uri))
					)
						return oauthError("invalid_request", "The token request is incomplete.");
					const id = yield* digest(crypto, presented);
					const now = yield* Clock.currentTimeMillis;
					const access = yield* random(crypto, "chirp_app_");
					const refresh = yield* random(crypto, "mcp_refresh_");
					const freshFamily = yield* random(crypto, "mcp_family_", 16);
					const issued = yield* ctx.mutate(
						Effect.gen(function* () {
							if (kind === "refresh") {
								const replayed = yield* lookup(ctx, id, "used_refresh");
								if (replayed && replayed.client_id === form.client_id && replayed.family) {
									yield* ctx.db`DELETE FROM example_mcp_oauth WHERE family=${replayed.family}`;
									return { state: "replayed" } as const;
								}
							}
							const row = yield* lookup(ctx, id, kind);
							if (!row || row.client_id !== form.client_id || row.expires_at <= now) return null;
							let granted: typeof Access.Type;
							const family = kind === "code" ? freshFamily : row.family;
							if (!family) return null;
							if (kind === "code") {
								const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Grant))(row.payload).pipe(
									Effect.result,
								);
								if (payload._tag === "Failure") return null;
								const challenge = Buffer.from(
									yield* crypto.digest("SHA-256", new TextEncoder().encode(form.code_verifier)),
								).toString("base64url");
								if (
									payload.success.redirect_uri !== form.redirect_uri ||
									payload.success.code_challenge !== challenge ||
									payload.success.resource !== resource
								)
									return null;
								granted = { resource, scopes: payload.success.scopes, subject: payload.success.subject };
							} else {
								const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Access))(row.payload).pipe(
									Effect.result,
								);
								if (payload._tag === "Failure") return null;
								if (payload.success.resource !== resource) return null;
								granted = payload.success;
							}
							if (kind === "code") yield* ctx.db`DELETE FROM example_mcp_oauth WHERE id=${id}`;
							else yield* ctx.db`UPDATE example_mcp_oauth SET kind='used_refresh' WHERE id=${id}`;
							const value = yield* Schema.encodeEffect(Schema.fromJsonString(Access))(granted);
							yield* store(ctx, {
								id: yield* digest(crypto, access),
								kind: "access",
								clientId: row.client_id,
								family,
								payload: value,
								expires: now + 60 * 60 * 1000,
							});
							yield* store(ctx, {
								id: yield* digest(crypto, refresh),
								kind: "refresh",
								clientId: row.client_id,
								family,
								payload: value,
								expires: now + 30 * 24 * 60 * 60 * 1000,
							});
							return { state: "issued", grant: granted } as const;
						}),
					);
					if (!issued || issued.state !== "issued")
						return oauthError("invalid_grant", "The grant is invalid, expired, or already used.");
					return Response.json(
						{
							access_token: access,
							token_type: "Bearer",
							expires_in: 3600,
							refresh_token: refresh,
							scope: issued.grant.scopes.join(" "),
						},
						{ headers: { "cache-control": "no-store", pragma: "no-cache" } },
					);
				}),
		});
		return (ctx: Context, authorization: string | undefined) => authenticate(crypto, resource, ctx, authorization);
	});

const authenticate = (crypto: Crypto.Crypto, resource: string, ctx: Context, authorization: string | undefined) =>
	Effect.gen(function* () {
		const match = /^Bearer (chirp_app_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
		if (!match?.[1]) return null;
		const row = yield* lookup(ctx, yield* digest(crypto, match[1]), "access");
		const now = yield* Clock.currentTimeMillis;
		if (!row || row.expires_at <= now) return null;
		const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Access))(row.payload).pipe(Effect.result);
		return payload._tag === "Success" && payload.success.resource === resource
			? ({
					clientId: row.client_id,
					subject: payload.success.subject,
					scopes: payload.success.scopes,
				} satisfies OAuthIdentity)
			: null;
	});
