import { lookup as resolve } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { on } from "@comms/storage/dialect";
import { Cause, Clock, Crypto, DateTime, Effect, Option, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { Api, ManagedRequestContext } from "../../kernel/extension-api.ts";
import { makeAddressPolicy } from "./addresses.ts";
import { type Editing, editingState, requestEditing, storedEditing } from "./grants.ts";
import { escape, page } from "./page.ts";

/** Fetch client metadata over http:// and from private addresses. Only for local development and tests, never on a public board. */
const allowLocalMetadata = false;
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
	/** The client_id of a metadata-document client: its document URL. Absent for a registered client. */
	client_url: Schema.optionalKey(Schema.String),
});
/** What this server reads from a Client ID Metadata Document; other fields are ignored. */
const Metadata = Schema.Struct({
	client_id: Schema.String,
	client_name: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
	token_endpoint_auth_method: Schema.optionalKey(Schema.String),
	token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Grant = Schema.Struct({
	redirect_uri: Schema.String,
	code_challenge: Schema.String,
	resource: Schema.String,
	scopes: Schema.Array(Schema.Union([Schema.Literal("read"), Schema.Literal("write")])),
	subject: Schema.String,
	agent: Schema.optionalKey(Schema.String),
	/**
	 * The client_id a metadata-document client presents. Its rows are keyed by a connection id minted at approval, since
	 * every install of one client shares its URL; a registered client presents the row's client_id.
	 */
	client_url: Schema.optionalKey(Schema.String),
});
/** An approved authorization waiting for the human to come back from boot's editing approval. */
const Consent = Schema.Struct({ ...Grant.fields, state: Schema.optionalKey(Schema.String) });
const Access = Schema.Struct({
	resource: Schema.String,
	scopes: Schema.Array(Schema.Union([Schema.Literal("read"), Schema.Literal("write")])),
	subject: Schema.String,
	agent: Schema.optionalKey(Schema.String),
	client_url: Schema.optionalKey(Schema.String),
});

type Context = ManagedRequestContext;
export interface OAuthIdentity {
	readonly clientId: string;
	readonly subject: string;
	readonly scopes: ReadonlyArray<"read" | "write">;
	/** The name approved at consent for posting; absent on read-only grants. */
	readonly agent: string | undefined;
	/** The metadata document URL a metadata-document client presents; undefined for a registered client. */
	readonly clientUrl: string | undefined;
}
const bodyLimit = 16384;
// The kernel refuses other names: boot reserves the board's human and itself, and system is the extension's own voice.
// Only the human reaches consent, so the signed-in identity names the human whichever boot this runs under.
const agentName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// `rollcall` is the board's roll-call extension (ext/rollcall.ts); a connection posing as it could fake verdicts.
const reservedAgents: ReadonlyArray<string> = ["system", "boot", "rollcall"];
const reservedAgent = (agent: string, human: string) => agent === human || reservedAgents.includes(agent);
/** A client's name as consent shows it. Claude Code names itself after the server, so here it registers as "Claude Code (chirp)". */
const shownName = (clientName: string) => clientName.replace(/\s*\(chirp\)\s*$/i, "") || clientName;
export const suggestedAgent = (clientName: string, human: string) => {
	const slug = shownName(clientName)
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+|-+$/g, "")
		.slice(0, 64);
	return slug && !reservedAgent(slug, human) ? slug : "mcp";
};
const oauthError = (error: string, description: string, status = 400) =>
	Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });
/** An authorization response. Each one names the issuer (RFC 9207), so a client can tell which server answered it. */
const redirect = (issuer: string, uri: string, fields: Readonly<Record<string, string>>) => {
	const target = new URL(uri);
	for (const [name, value] of Object.entries({ ...fields, iss: issuer })) target.searchParams.set(name, value);
	return new Response(null, {
		status: 302,
		headers: { location: target.href, "cache-control": "no-store" },
	});
};
const one = (value: string | ReadonlyArray<string> | undefined) => (typeof value === "string" ? value : undefined);
// Every connection is granted the whole tool surface, whatever scope the client requests (RFC 6749 §3.3 lets the
// server ignore it; the token response reports the grant). Clients cache the scope they saw at registration: ChatGPT
// kept requesting read alone after write was added, and so could never post.
const granted: ReadonlyArray<"read" | "write"> = ["read", "write"];
const loopback: ReadonlyArray<string> = ["127.0.0.1", "[::1]", "localhost"];
/**
 * A host as the URL parser leaves a real one: lowercase letters, digits, dots and dashes (IDNs come out as punycode), or
 * a bracketed IPv6 literal. The parser lets through characters such as `;` and `'`, and a callback's origin is written
 * into consent's CSP.
 */
const plainHost = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;
const validRedirect = (value: string) => {
	try {
		const url = new URL(value);
		return (
			!url.hash &&
			!url.username &&
			!url.password &&
			plainHost.test(url.hostname) &&
			(url.protocol === "https:" || (url.protocol === "http:" && loopback.includes(url.hostname)))
		);
	} catch {
		return false;
	}
};
/**
 * A redirect URI as it is matched: exactly, except that a loopback one may name any port (OAuth 2.1 §8.4.2), since a
 * native client listens wherever the system lets it. Claude Code registers localhost as well as 127.0.0.1.
 */
const matched = (uri: string) => {
	const url = URL.parse(uri);
	if (!url || url.protocol !== "http:" || !loopback.includes(url.hostname)) return uri;
	// Drop only the port. URL.href would also resolve dot segments and normalize the host.
	return uri.replace(/^http:\/\/(\[[^\]]+\]|[^/?#:]+):\d+/i, "http://$1");
};
const metadataPrefix = "mcp_cimd_";
/** A client_id naming its Client ID Metadata Document (CIMD §3): https, a path, no userinfo, fragment or dot segments. */
const metadataUrl = (clientId: string) => {
	const url = URL.parse(clientId);
	return url &&
		clientId.length <= 2048 &&
		(url.protocol === "https:" || (allowLocalMetadata && url.protocol === "http:")) &&
		url.pathname !== "/" &&
		!url.username &&
		!url.password &&
		!clientId.includes("#") &&
		// Parsing resolves dot segments and normalizes case, so only an id already in that form is fetched as named.
		url.href === clientId
		? url
		: undefined;
};
const metadataLimit = 5120;
const cachedDocuments = 64;
/** How long a fetched document is reused. This shared cache uses Cache-Control s-maxage, then max-age, then Expires (CIMD §5.2, RFC 9111), at most an hour, five minutes if none is set. private, no-store, no-cache, and Vary: * are not stored. Current age (Age and Date, RFC 9111 §4.2.3) reduces remaining freshness, including the five-minute fallback; an invalid Expires is already stale (RFC 9111 §5.3). Quoted s-maxage and max-age values are accepted (RFC 9111 §5.2). A duplicated or malformed s-maxage or max-age is stale (RFC 9111 §4.2.1). */
const cacheLifetime = (
	header: string | undefined,
	ageHeader: string | undefined,
	expiresHeader: string | undefined,
	dateHeader: string | undefined,
	varyHeader: string | undefined,
	now: number,
) => {
	const directives = (header ?? "")
		.toLowerCase()
		.split(",")
		.map((directive) => directive.trim());
	if (directives.includes("no-store") || directives.includes("no-cache") || directives.includes("private")) return 0;
	const vary = (varyHeader ?? "")
		.toLowerCase()
		.split(",")
		.map((field) => field.trim());
	if (vary.includes("*")) return 0;
	const seconds = (name: string) => {
		const found = directives.filter((directive) => directive === name || directive.startsWith(`${name}=`));
		if (found.length === 0) return;
		const values = found.flatMap((directive) => {
			const match = new RegExp(`^${name}=(?:"(\\d+)"|(\\d+))$`).exec(directive);
			const value = match?.[1] ?? match?.[2];
			return value === undefined ? [] : [value];
		});
		// A duplicated or malformed freshness directive is invalid; treat the response as stale (RFC 9111 §4.2.1).
		return values.length === 1 && found.length === 1 ? values[0] : 0;
	};
	const shared = seconds("s-maxage") ?? seconds("max-age");
	const age = Number(/^(\d+)$/.exec((ageHeader ?? "").trim())?.[1] ?? 0);
	const parsedDate = dateHeader === undefined ? Number.NaN : Date.parse(dateHeader);
	const origin = Number.isNaN(parsedDate) ? now : parsedDate;
	const currentAge = Math.max(Math.max(0, Math.floor((now - origin) / 1000)), age);
	let freshness: number;
	if (shared !== undefined) freshness = Math.min(Number(shared), 3600);
	else if (expiresHeader !== undefined) {
		const expires = Date.parse(expiresHeader);
		if (Number.isNaN(expires)) return 0;
		freshness = Math.min(Math.max(0, Math.floor((expires - origin) / 1000)), 3600);
	} else freshness = 300;
	const remaining = freshness - currentAge;
	return remaining > 0 ? remaining * 1000 : 0;
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
/**
 * Registration is anonymous, so a registered client no human has approved lapses an hour after registering, and at most
 * this many wait at once; past that, a registration evicts the oldest. Approving one at consent keeps it (expires_at 0),
 * as every client from before this rule is.
 */
const pendingLifetime = 60 * 60 * 1000;
const pendingClients = 500;
/**
 * The registered clients among `ids` that a code, consent or token names. Approval keeps a client before issuing
 * anything, but a generation from before that rule, run again after a rollback, approves without keeping; a client with
 * credentials stays registered whatever its expiry says.
 */
const referenced = (ctx: Context, ids: ReadonlyArray<string>) =>
	ids.length === 0
		? Effect.succeed(new Set<string>())
		: ctx.db`SELECT DISTINCT client_id FROM example_mcp_oauth WHERE kind IN ('code','consent','access','refresh','used_refresh') AND client_id IN ${ctx.db.in(ids)}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ client_id: Schema.String })))),
				Effect.map((rows) => new Set(rows.map((row) => row.client_id))),
			);
/** A registration past its expiry that nothing it was issued still names. */
const lapsed = (ctx: Context, row: typeof Stored.Type) =>
	Effect.gen(function* () {
		if (row.expires_at === 0 || row.expires_at > (yield* Clock.currentTimeMillis)) return false;
		return !(yield* referenced(ctx, [row.id])).has(row.id);
	});
const client = (ctx: Context, clientId: string) =>
	Effect.gen(function* () {
		const row = yield* lookup(ctx, clientId, "client");
		if (!row || (yield* lapsed(ctx, row))) return undefined;
		return yield* Schema.decodeEffect(Schema.fromJsonString(Client))(row.payload);
	});
/**
 * Keeps a registered client a human just approved. Run inside the ctx.mutate that stores its code or consent; false
 * when it lapsed or was evicted after consent checked it, so nothing is issued for a client that is gone.
 */
const keep = (ctx: Context, clientId: string) =>
	Effect.gen(function* () {
		const row = yield* lookup(ctx, clientId, "client");
		if (!row || (yield* lapsed(ctx, row))) return false;
		if (row.expires_at !== 0)
			yield* ctx.db`UPDATE example_mcp_oauth SET expires_at=0 WHERE id=${clientId} AND kind='client'`;
		return true;
	});
const unregistered = "client_id is not registered with this board.";
/** A client's registered name as a short slug. */
const nameLabel = (clientName: string) =>
	clientName
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 32)
		.replace(/[^a-z0-9]+$/, "") || "mcp";
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
/**
 * The label a client's own calls carry, worked out from the client alone: the host of its metadata document, then a
 * known name, then its name as a slug. Consent sees only the browser, so this is how the grant approved there is the
 * one the client's calls find; it also labels a client whose User-Agent this server does not recognise.
 */
export const clientSurface = (registered: typeof Client.Type | undefined) => {
	const host = URL.parse(registered?.client_url ?? "")?.hostname ?? "";
	const name = registered?.client_name ?? "mcp";
	if (within(host, "claude.ai")) return "claude";
	if (within(host, "chatgpt.com") || within(host, "openai.com")) return "chatgpt";
	if (/^claude/i.test(name)) return "claude";
	if (/^chatgpt/i.test(name)) return "chatgpt";
	return nameLabel(name);
};
/** The label of the registered client behind a connection. */
export const clientLabel = (ctx: Context, clientId: string) => client(ctx, clientId).pipe(Effect.map(clientSurface));
/**
 * Which client is calling, as the label after its posting name (`dot@codex`). One connection can serve several:
 * ChatGPT and Codex share ChatGPT's connector, OAuth client and token, and only the User-Agent tells them apart. The
 * client asserts it, so a label separates attribution and approvals, not trust.
 */
export const surfaceOf = (ctx: Context, clientId: string, userAgent: string | undefined) => {
	const agent = userAgent ?? "";
	if (agent.startsWith("openai-mcp/")) return Effect.succeed(agent.includes("(Codex)") ? "codex" : "chatgpt");
	if (agent.includes("Claude-User")) return Effect.succeed("claude");
	return clientLabel(ctx, clientId);
};
/** A LIKE pattern, escaped with `!`, for one JSON string field of a payload. */
const payloadField = (name: string, value: string) =>
	`%"${name}":${JSON.stringify(value).replace(/[!%_]/g, (character) => `!${character}`)}%`;
/**
 * The name this client last posted under for the human now approving, so reconnecting keeps it instead of reverting to
 * the client's own name. Another human's grant for the same client never supplies the name. A metadata-document client
 * gets a new connection each time, so its earlier ones are found by its URL.
 */
const previousAgent = (ctx: Context, clientId: string, url: URL | undefined, subject: string) =>
	// Narrow to this human in SQL before the limit, so other humans' grants cannot push theirs out; then check exactly.
	(url
		? ctx.db`SELECT payload FROM example_mcp_oauth WHERE kind IN ('access','refresh','used_refresh') AND payload LIKE ${payloadField("subject", subject)} ESCAPE '!' AND payload LIKE ${payloadField("client_url", clientId)} ESCAPE '!' ORDER BY created_at DESC LIMIT 50`
		: ctx.db`SELECT payload FROM example_mcp_oauth WHERE client_id=${clientId} AND kind IN ('access','refresh','used_refresh') AND payload LIKE ${payloadField("subject", subject)} ESCAPE '!' ORDER BY created_at DESC LIMIT 50`
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ payload: Schema.String })))),
		Effect.flatMap((rows) =>
			Effect.forEach(rows, (row) =>
				Schema.decodeEffect(Schema.fromJsonString(Access))(row.payload).pipe(Effect.option),
			),
		),
		Effect.map((grants) =>
			grants.flatMap((grant) =>
				Option.isSome(grant) && grant.value.subject === subject && grant.value.client_url === (url && clientId)
					? [grant.value]
					: [],
			),
		),
		Effect.map((own) => own.find((grant) => grant.agent !== undefined)?.agent),
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
});
/** The client a client_id names. */
interface Found {
	readonly client: typeof Client.Type;
	/** Where a client identified by its metadata document published it. */
	readonly metadata: URL | undefined;
}
/** Returns the checked request, or names the first failed check so the person at the consent page can fix the client. */
const authorization = <E, R>(
	query: Context["query"],
	resource: string,
	find: (clientId: string) => Effect.Effect<Found | string, E, R>,
) =>
	Effect.gen(function* () {
		const input = authorizeInput(query);
		if (!input.clientId) return unregistered;
		const found = yield* find(input.clientId);
		if (typeof found === "string") return found;
		const redirectUri = input.redirectUri;
		if (!redirectUri || !found.client.redirect_uris.some((uri) => matched(uri) === matched(redirectUri)))
			return "redirect_uri is not registered for this client.";
		if (input.responseType !== "code") return "response_type must be code.";
		if (input.resource !== resource) return `resource must be ${resource}; connect the client to exactly that URL.`;
		if (input.state !== undefined && input.state.length > 2048) return "state must be at most 2048 characters.";
		if (input.challengeMethod !== "S256" || !input.challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(input.challenge))
			return "code_challenge must be an S256 PKCE challenge.";
		return {
			clientId: input.clientId,
			client: found.client,
			clientName: found.client.client_name,
			metadata: found.metadata,
			redirectUri,
			challenge: input.challenge,
			scopes: granted,
			state: input.state,
		};
	});

const signIn = (url: string) =>
	new Response(null, {
		status: 302,
		headers: { location: `/auth/login?next=${encodeURIComponent(url)}`, "cache-control": "no-store" },
	});
/**
 * Loads `next`, the URL that was asked for plus a marker, from this page. A link from the client's site arrives
 * cross-site, which leaves boot's SameSite=Strict session cookie behind; this reload is same-site, so the cookie rides
 * and a signed-in human goes straight to consent. Boot's GitHub and Google sign-in does the same.
 */
const bounce = (next: string) =>
	page({
		title: "Connecting",
		head: `<meta http-equiv="refresh" content="0;url=${escape(next)}">`,
		body: `<h1>One moment</h1><p>Checking that you're signed in to this board. <a href="${escape(next)}">Continue</a></p>`,
		formAction: "'none'",
	});
/** A refusal the person sees in the browser, where a client would read an OAuth error. */
const refusal = (title: string, detail: string, next: string, status = 400) =>
	page({
		title,
		body: `<h1>${escape(title)}</h1><p class="detail">${escape(detail)}</p><p class="muted">${escape(next)}</p>`,
		formAction: "'none'",
		status,
	});
const signedOut = () =>
	refusal("Sign in again", "Your session on this board ended.", "Sign in, then connect the app again.", 401);
/** An authorization request consent cannot show. A client may keep using a registration that lapsed unapproved. */
const cannotConnect = (detail: string) =>
	refusal(
		"This app can't connect",
		detail,
		detail === unregistered
			? "Nothing was connected. If the app tried to connect here before, remove this board from it and add it again."
			: "Nothing was connected.",
	);
const usedLink = () =>
	refusal(
		"This link has expired",
		"It was already used, or it's more than 20 minutes old.",
		"If the app isn't connected yet, connect it again from its settings.",
	);
const longDate = (at: number) => DateTime.formatUtc(DateTime.makeUnsafe(at), { locale: "en-US", dateStyle: "long" });
/** What the human is told on the way back from boot's approval page. */
const outcome = (editing: Editing, name: string, approve: string) => {
	const client = escape(name);
	const choice = `You can still connect ${client} to read this board and post to it, without editing, or not connect it.`;
	if (editing.status === "active") {
		const powers = [
			...(editing.scopes.includes("write") ? ["edit and delete its own posts and manage topics"] : []),
			...(editing.scopes.includes("fs") ? ["edit pages and the board's own code"] : []),
		];
		return powers.length === 0
			? `<p>You allowed reading only, so ${client} can read and post but not edit. It can ask again later.</p>`
			: `<p>Editing is approved. ${client} can ${powers.join(", and ")} as <strong>${escape(editing.agent ?? "")}</strong> until ${escape(longDate(editing.expires_at ?? 0))}. You can turn this off from your account.</p>`;
	}
	if (editing.status === "pending")
		return `<p>Editing is still waiting for your approval. <a href="${escape(approve)}">Approve it with your passkey</a>, or decide here. ${choice}</p>`;
	if (editing.status === "expired") return `<p>The editing request expired before it was approved. ${choice}</p>`;
	if (editing.status === "revoked") return `<p>Editing was turned off. ${choice}</p>`;
	if (editing.status === "denied") return `<p>Editing wasn't approved. ${choice}</p>`;
	return `<p>Editing wasn't set up. ${choice}</p>`;
};

export const installOAuth = (api: Api, origin: string, resourceOrigin = origin) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const resource = `${resourceOrigin}/mcp`;
		const publicAddress = makeAddressPolicy();
		/**
		 * Fetches a client's metadata document like an event delivery: only from addresses checked public at fetch time,
		 * connecting to the checked address with the original hostname for TLS, never following redirects, and reading
		 * at most 5 KiB (CIMD §8.6, §8.7) within five seconds. Returns the client, or what is wrong with the document.
		 */
		const fetchMetadata = (url: URL) =>
			Effect.gen(function* () {
				const hostname = url.hostname.replace(/^\[|\]$/g, "");
				const resolved = yield* Effect.tryPromise(() => resolve(hostname, { all: true, verbatim: true })).pipe(
					Effect.orElseSucceed(() => []),
				);
				const address = resolved[0];
				if (!address || (!allowLocalMetadata && resolved.some((item) => !publicAddress(item.address))))
					return "is not on a public address";
				const pinned = new URL(url.href);
				pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
				const init: BunFetchRequestInit = {
					redirect: "manual",
					credentials: "omit",
					...(url.protocol === "https:"
						? {
								tls: {
									...(isIP(hostname) === 0 ? { serverName: hostname } : {}),
									checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
								},
							}
						: {}),
				};
				const request = HttpClientRequest.get(pinned.href).pipe(
					HttpClientRequest.setHeaders({ host: url.host, accept: "application/json" }),
				);
				const outcome = yield* api.effects
					.fetch(request, (response) =>
						Effect.gen(function* () {
							if (response.status !== 200) return `answered HTTP ${response.status}`;
							const chunks: Array<Uint8Array> = [];
							let size = 0;
							yield* response.stream.pipe(
								Stream.takeWhile(() => size <= metadataLimit),
								Stream.runForEach((chunk) =>
									Effect.sync(() => {
										size += chunk.byteLength;
										chunks.push(chunk);
									}),
								),
							);
							if (size > metadataLimit) return "is larger than 5 KiB";
							return {
								text: Buffer.concat(chunks).toString("utf8"),
								cacheControl: response.headers["cache-control"],
								age: response.headers.age,
								expires: response.headers.expires,
								date: response.headers.date,
								vary: response.headers.vary,
							};
						}),
					)
					.pipe(Effect.provideService(FetchHttpClient.RequestInit, init), Effect.exit);
				if (outcome._tag === "Failure") {
					if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
					return "could not be fetched";
				}
				if (outcome.value.status === "suppressed") return "could not be fetched";
				const read = outcome.value.value;
				if (typeof read === "string") return read;
				const document = Schema.decodeUnknownOption(Schema.fromJsonString(Metadata))(read.text);
				if (Option.isNone(document)) return "is not JSON with client_id, client_name and redirect_uris";
				const { client_id, client_name, redirect_uris } = document.value;
				if (client_id !== url.href) return "names a different client_id";
				if (!client_name.trim() || client_name.length > 200) return "needs a client_name of up to 200 characters";
				// RFC 7591 defaults an omitted method to client_secret_basic. This board accepts only public clients, so none
				// must be the selected method or listed among the supported ones. ChatGPT prefers private_key_jwt and lists none.
				const supportsNone = document.value.token_endpoint_auth_methods_supported?.includes("none") ?? false;
				if (document.value.token_endpoint_auth_method !== "none" && !supportsNone)
					return "requires client authentication, and this board accepts only public clients";
				const redirects = redirect_uris.filter((uri) => uri.length <= 2048 && validRedirect(uri));
				if (redirects.length === 0) return "lists no HTTPS or loopback redirect URI";
				return {
					client: { client_name: client_name.trim(), redirect_uris: redirects, client_url: client_id },
					lifetime: cacheLifetime(
						read.cacheControl,
						read.age,
						read.expires,
						read.date,
						read.vary,
						yield* Clock.currentTimeMillis,
					),
				};
			}).pipe(
				Effect.timeoutOption("5 seconds"),
				Effect.map(Option.getOrElse(() => "did not arrive within five seconds")),
			);
		/** Documents by URL, each kept for its cache lifetime; failures and invalid documents never are (CIMD §5.2). */
		const documents = yield* Ref.make<
			ReadonlyMap<string, { readonly client: typeof Client.Type; readonly until: number }>
		>(new Map());
		const metadata = (url: URL) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				const cached = (yield* Ref.get(documents)).get(url.href);
				if (cached && cached.until > now) return cached.client;
				const fetched = yield* fetchMetadata(url);
				if (typeof fetched === "string") return fetched;
				if (fetched.lifetime > 0)
					yield* Ref.update(
						documents,
						(current) =>
							new Map([
								...[...current]
									.filter(([key, entry]) => key !== url.href && entry.until > now)
									.slice(1 - cachedDocuments),
								[url.href, { client: fetched.client, until: now + fetched.lifetime }],
							]),
					);
				return fetched.client;
			});
		const find = (ctx: Context, clientId: string) =>
			Effect.gen(function* () {
				const url = metadataUrl(clientId);
				if (!url) {
					const registered = clientId.startsWith(metadataPrefix) ? undefined : yield* client(ctx, clientId);
					return registered ? ({ client: registered, metadata: undefined } satisfies Found) : unregistered;
				}
				const described = yield* metadata(url);
				if (typeof described === "string") return `The client metadata document at ${clientId} ${described}.`;
				return { client: described, metadata: url } satisfies Found;
			});
		/**
		 * Records a metadata-document connection as a client, so its name shows wherever a registered client's does. Run
		 * inside the ctx.mutate that stores the connection's code or consent, so no approval leaves one behind alone.
		 */
		const remember = (ctx: Context, id: string, described: typeof Client.Type) =>
			Schema.encodeEffect(Schema.fromJsonString(Client))(described).pipe(
				Effect.flatMap((payload) => store(ctx, { id, kind: "client", clientId: id, family: "", payload, expires: 0 })),
			);
		/** Mints the one-use authorization code for an approved grant; run inside ctx.mutate. */
		const issue = (ctx: Context, clientId: string, grant: typeof Grant.Type) =>
			Effect.gen(function* () {
				const code = yield* random(crypto, "mcp_code_");
				const now = yield* Clock.currentTimeMillis;
				yield* store(ctx, {
					id: yield* digest(crypto, code),
					kind: "code",
					clientId,
					family: "",
					payload: yield* Schema.encodeEffect(Schema.fromJsonString(Grant))(grant),
					expires: now + 5 * 60 * 1000,
				});
				return code;
			});
		const continuation = (token: string) => `/mcp/oauth/continue?consent=${encodeURIComponent(token)}`;
		const approveLink = (approveUrl: string, token: string) => {
			const target = new URL(approveUrl);
			target.searchParams.set("return", continuation(token));
			return target.href;
		};
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
			description: "OAuth protected-resource metadata for the MCP extension.",
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
			description: "OAuth authorization-server metadata for the MCP extension.",
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
						// Clients may add offline_access for a refresh token (MCP 2026-07-28, Refresh Tokens). Accepted and ignored:
						// every grant gets one. The resource's metadata and challenge leave it out, as that section asks.
						scopes_supported: ["read", "write", "offline_access"],
						client_id_metadata_document_supported: true,
						authorization_response_iss_parameter_supported: true,
					}),
				),
		});
		api.route("POST", "/mcp/oauth/register", {
			description: "Register a public OAuth client for the MCP extension.",
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
					const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Client))({
						client_name: input.client_name.trim(),
						redirect_uris: input.redirect_uris,
					});
					// A plain read, outside the write lock, picks what to drop: every lapsed registration, and while the cap is
					// full the oldest still waiting. Registering never fails, so a burst only pushes out other unapproved
					// registrations. Registrations racing this read can overshoot the cap; the next one evicts back down.
					const waiting =
						yield* ctx.db`SELECT id,expires_at FROM example_mcp_oauth WHERE kind='client' AND expires_at>0 ORDER BY expires_at LIMIT ${pendingClients * 2}`.pipe(
							Effect.flatMap(
								Schema.decodeUnknownEffect(
									Schema.Array(Schema.Struct({ id: Schema.String, expires_at: Schema.Finite })),
								),
							),
						);
					const live = waiting.filter((row) => row.expires_at > now);
					const candidates = [
						...waiting.filter((row) => row.expires_at <= now),
						...live.slice(0, Math.max(0, live.length - pendingClients + 1)),
					].map((row) => row.id);
					// One that a code, consent or token names is kept instead.
					const credited = yield* referenced(ctx, candidates);
					const dropped = candidates.filter((id) => !credited.has(id));
					yield* ctx.mutate(
						Effect.gen(function* () {
							if (credited.size > 0)
								yield* ctx.db`UPDATE example_mcp_oauth SET expires_at=0 WHERE kind='client' AND id IN ${ctx.db.in([...credited])}`;
							// expires_at>0 spares a registration a human approved after the read: approval keeps it first.
							if (dropped.length > 0)
								yield* ctx.db`DELETE FROM example_mcp_oauth WHERE kind='client' AND expires_at>0 AND id IN ${ctx.db.in(dropped)}`;
							yield* store(ctx, {
								id: clientId,
								kind: "client",
								clientId,
								family: "",
								payload,
								expires: now + pendingLifetime,
							});
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
					if (ctx.identity?.kind !== "human") {
						// Path and query only, re-encoded, so the page below can name it safely.
						const asked = new URL(request.url, origin);
						const bounced = asked.searchParams.get("bounced") === "1";
						asked.searchParams.delete("bounced");
						// One reload from the board, never more: still signed out after it means signed out.
						if (!bounced && request.headers["sec-fetch-site"] === "cross-site") {
							asked.searchParams.set("bounced", "1");
							return bounce(asked.pathname + asked.search);
						}
						return signIn(asked.pathname + asked.search);
					}
					const checked = yield* authorization(ctx.query, resource, (clientId) => find(ctx, clientId));
					if (typeof checked === "string") return cannotConnect(checked);
					const name = shownName(checked.clientName);
					const postAs =
						(yield* previousAgent(ctx, checked.clientId, checked.metadata, ctx.identity.agent)) ??
						suggestedAgent(checked.clientName, ctx.identity.agent);
					// Consent names where it returns (MCP requires the hostname), and who published a metadata document when
					// that is another host. Any local program can use a loopback callback with another client's metadata, so
					// that gets a warning.
					const callback = new URL(checked.redirectUri);
					const returns = loopback.includes(callback.hostname)
						? ` You'll go back to <strong>${escape(callback.host)}</strong>, a program on this computer. Any program here can claim to be ${escape(name)}, so connect only if you just started this.`
						: ` You'll go back to <strong>${escape(callback.host)}</strong>.`;
					const publisher =
						checked.metadata && checked.metadata.host !== callback.host
							? ` Its details are published by <strong>${escape(checked.metadata.host)}</strong>.`
							: "";
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
					const posting = checked.scopes.includes("write")
						? `<details class="name"><summary><span>Posts as <strong>${escape(postAs)}</strong></span><span class="change">Change</span></summary><label for="agent">Posting name</label><input id="agent" name="agent" value="${escape(postAs)}" required maxlength="64" pattern="[a-z0-9][a-z0-9._\\-]*" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="agent-hint"><p class="hint" id="agent-hint">Up to 64 lowercase letters, digits, dots, dashes or underscores.</p></details><label class="check"><input type="checkbox" name="editing" value="1" checked><span>Also let it edit and delete its own posts and manage topics. You'll confirm with your passkey on the next screen.</span></label><p class="note">Editing pages and the board's own code is a separate choice on the next screen.</p>`
						: "";
					return page({
						title: `Connect ${name}`,
						body: `<h1>Connect ${escape(name)} to chirp</h1><p>${escape(name)} will be able to read this board and post to it.${returns}${publisher}</p><form id="consent" method="post" action="/mcp/oauth/authorize">${[...hidden].map(([field, value]) => `<input type="hidden" name="${escape(field)}" value="${escape(value)}">`).join("")}${posting}<div class="actions"><button name="decision" value="approve">Connect</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button></div></form>`,
						formAction: `'self' ${callback.origin}`,
						script: "consent",
					});
				}),
		});
		api.route("POST", "/mcp/oauth/authorize", {
			description: "Approve or deny an MCP OAuth client after passkey sign-in.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (ctx.identity?.kind !== "human") return signedOut();
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded")
						return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.", 415);
					const text = yield* boundedText(request);
					if (text === null) return oauthError("invalid_request", "Request body is too large or timed out.");
					const form = Object.fromEntries(new URLSearchParams(text));
					const checked = yield* authorization(form, resource, (clientId) => find(ctx, clientId));
					if (typeof checked === "string") return cannotConnect(checked);
					if (form.decision !== "approve")
						return redirect(origin, checked.redirectUri, {
							error: "access_denied",
							...(checked.state === undefined ? {} : { state: checked.state }),
						});
					const agent = checked.scopes.includes("write") ? form.agent?.trim() : undefined;
					if (
						checked.scopes.includes("write") &&
						(!agent || reservedAgent(agent, ctx.identity.agent) || !agentName.test(agent))
					)
						return refusal(
							"Choose another posting name",
							`Choose a posting name of up to 64 lowercase letters, digits, dots, dashes or underscores, other than system, boot or your own name, ${ctx.identity.agent}.`,
							"Go back, change it, and connect again.",
						);
					// Every install and every user account of a metadata-document client presents the same URL and callback
					// (chatgpt.com and claude.ai serve one document to all their users), and any local program can present a
					// native client's, so the callback cannot tell whose flow this is. Each approval is its own connection and
					// never inherits another's editing grant.
					const clientId = checked.metadata ? yield* random(crypto, metadataPrefix, 24) : checked.clientId;
					// Approving keeps a registered client; a metadata-document connection is recorded as one.
					const recorded = checked.metadata
						? remember(ctx, clientId, checked.client).pipe(Effect.as(true))
						: keep(ctx, clientId);
					const grant = {
						redirect_uri: checked.redirectUri,
						code_challenge: checked.challenge,
						resource,
						scopes: checked.scopes,
						subject: ctx.identity.agent,
						...(agent ? { agent } : {}),
						...(checked.metadata ? { client_url: checked.clientId } : {}),
					};
					if (agent && form.editing === "1") {
						// One grant per connection and surface: this human's live grant under this name is kept and its waiting
						// request shown again, because replacing either would leave a grant boot honours that nothing tracks.
						// Another human's or another name's grant is never reused; a new request replaces it. Consent sees the
						// browser, not the client, so the grant is for the label the client's own calls will carry.
						const surface = clientSurface(checked.client);
						const holder = { clientId, surface, subject: ctx.identity.agent, agent };
						const current = yield* editingState(ctx, holder, { refresh: true }).pipe(
							Effect.catchTag("KernelError", () => storedEditing(ctx, holder)),
						);
						// Boot refusing the request must not block the connection: it still reads and posts.
						const requested =
							current.status === "active"
								? undefined
								: current.status === "pending"
									? current
									: yield* requestEditing(ctx, origin, holder).pipe(
											Effect.catchTag("KernelError", () => Effect.succeed(undefined)),
										);
						if (requested?.approve_url) {
							const token = yield* random(crypto, "mcp_consent_");
							const now = yield* Clock.currentTimeMillis;
							const pending = {
								id: yield* digest(crypto, token),
								kind: "consent",
								clientId,
								family: "",
								payload: yield* Schema.encodeEffect(Schema.fromJsonString(Consent))({
									...grant,
									...(checked.state === undefined ? {} : { state: checked.state }),
								}),
								expires: now + 20 * 60 * 1000,
							};
							const saved = yield* ctx.mutate(
								Effect.gen(function* () {
									if (!(yield* recorded)) return false;
									yield* store(ctx, pending);
									return true;
								}),
							);
							if (!saved) return cannotConnect(unregistered);
							// Straight to boot's own approval page, which shows the request and takes the decision. Approving or
							// denying there comes back to the continue route, which finishes connecting either way; the consent
							// checkbox is the way to skip editing.
							return new Response(null, {
								status: 303,
								headers: { location: approveLink(requested.approve_url, token), "cache-control": "no-store" },
							});
						}
					}
					const code = yield* ctx.mutate(
						Effect.gen(function* () {
							return (yield* recorded) ? yield* issue(ctx, clientId, grant) : undefined;
						}),
					);
					if (code === undefined) return cannotConnect(unregistered);
					return redirect(origin, checked.redirectUri, {
						code,
						...(checked.state === undefined ? {} : { state: checked.state }),
					});
				}),
		});
		api.route("GET", "/mcp/oauth/continue", {
			description:
				"Where boot's editing approval returns the human: shows whether editing was approved, then finishes connecting the MCP client.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (ctx.identity?.kind !== "human") return signIn(request.url);
					const token = one(ctx.query.consent);
					const row = token ? yield* lookup(ctx, yield* digest(crypto, token), "consent") : undefined;
					const now = yield* Clock.currentTimeMillis;
					const consent = row ? yield* Schema.decodeEffect(Schema.fromJsonString(Consent))(row.payload) : undefined;
					// A used token is gone, so going back to this page after finishing shows this rather than sending it again.
					if (!token || !row || !consent || row.expires_at <= now || consent.subject !== ctx.identity.agent)
						return usedLink();
					const name = shownName((yield* client(ctx, row.client_id))?.client_name ?? "the app");
					// A GET may not record anything, so the decision is collected again when the form is sent.
					const holder = {
						clientId: row.client_id,
						surface: yield* clientLabel(ctx, row.client_id),
						subject: consent.subject,
						agent: consent.agent,
					};
					const editing = yield* editingState(ctx, holder, { readOnly: true }).pipe(
						Effect.catchTag("KernelError", () => storedEditing(ctx, holder)),
					);
					// Boot returns here once the human decided. Only an approval finishes by itself. After a denial, an expiry
					// or a revocation, the human chooses between connecting without editing and not connecting at all, since
					// denying at boot may have meant either; a request still waiting can also be approved from here.
					const approved = editing.status === "active";
					const callback = new URL(consent.redirect_uri);
					const buttons = approved
						? `<button id="finish-button" data-busy="Returning you to ${escape(callback.host)}…">Continue to ${escape(name)}</button>`
						: `<div class="actions"><button name="decision" value="connect">Connect without editing</button><button class="secondary" name="decision" value="cancel">Don't connect</button></div>`;
					return page({
						title: `Finish connecting ${name}`,
						body: `<h1>Finish connecting ${escape(name)}</h1>${outcome(editing, name, editing.approve_url ? approveLink(editing.approve_url, token) : "")}<form id="finish" method="post" action="/mcp/oauth/continue"><input type="hidden" name="consent" value="${escape(token)}">${buttons}</form>`,
						formAction: `'self' ${callback.origin}`,
						...(approved ? { script: "finish" as const } : {}),
					});
				}),
		});
		api.route("POST", "/mcp/oauth/continue", {
			description:
				"Finish connecting an MCP client after boot's editing approval, with or without editing, or end it without connecting.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (ctx.identity?.kind !== "human") return signedOut();
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/x-www-form-urlencoded")
						return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.", 415);
					const text = yield* boundedText(request);
					if (text === null) return oauthError("invalid_request", "Request body is too large or timed out.");
					const form = new URLSearchParams(text);
					const token = form.get("consent");
					if (!token) return usedLink();
					const connect = form.get("decision") !== "cancel";
					const id = yield* digest(crypto, token);
					const subject = ctx.identity.agent;
					const now = yield* Clock.currentTimeMillis;
					const finished = yield* ctx.mutate(
						Effect.gen(function* () {
							const row = yield* lookup(ctx, id, "consent");
							if (!row || row.expires_at <= now) return undefined;
							const consent = yield* Schema.decodeEffect(Schema.fromJsonString(Consent))(row.payload);
							if (consent.subject !== subject) return undefined;
							yield* ctx.db`DELETE FROM example_mcp_oauth WHERE id=${id}`;
							const { state, ...grant } = consent;
							return {
								holder: { clientId: row.client_id, subject: consent.subject, agent: consent.agent },
								redirectUri: grant.redirect_uri,
								state,
								code: connect ? yield* issue(ctx, row.client_id, grant) : undefined,
							};
						}),
					);
					if (!finished) return usedLink();
					// Not connecting spends the token and answers the client as a denial at consent would.
					if (finished.code === undefined)
						return redirect(origin, finished.redirectUri, {
							error: "access_denied",
							...(finished.state === undefined ? {} : { state: finished.state }),
						});
					// Record the decision now, so the client's first tool call need not ask boot.
					yield* editingState(ctx, {
						...finished.holder,
						surface: yield* clientLabel(ctx, finished.holder.clientId),
					}).pipe(Effect.catchTag("KernelError", () => Effect.void));
					return redirect(origin, finished.redirectUri, {
						code: finished.code,
						...(finished.state === undefined ? {} : { state: finished.state }),
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
					// Who may redeem a row: a metadata-document client by its URL, a registered client by its id.
					const redeemer = (row: typeof Stored.Type, payload: { readonly client_url?: string }) =>
						payload.client_url ?? row.client_id;
					const issued = yield* ctx.mutate(
						Effect.gen(function* () {
							if (kind === "refresh") {
								const replayed = yield* lookup(ctx, id, "used_refresh");
								const used = Option.flatMap(Option.fromUndefinedOr(replayed), (row) =>
									Schema.decodeUnknownOption(Schema.fromJsonString(Access))(row.payload),
								);
								if (
									replayed &&
									replayed.family &&
									Option.isSome(used) &&
									redeemer(replayed, used.value) === form.client_id
								) {
									yield* ctx.db`DELETE FROM example_mcp_oauth WHERE family=${replayed.family}`;
									return { state: "replayed" } as const;
								}
							}
							const row = yield* lookup(ctx, id, kind);
							if (!row || row.expires_at <= now) return null;
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
									redeemer(row, payload.success) !== form.client_id ||
									payload.success.redirect_uri !== form.redirect_uri ||
									payload.success.code_challenge !== challenge ||
									payload.success.resource !== resource
								)
									return null;
								granted = {
									resource,
									scopes: payload.success.scopes,
									subject: payload.success.subject,
									...(payload.success.agent === undefined ? {} : { agent: payload.success.agent }),
									...(payload.success.client_url === undefined ? {} : { client_url: payload.success.client_url }),
								};
							} else {
								const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Access))(row.payload).pipe(
									Effect.result,
								);
								if (payload._tag === "Failure") return null;
								if (redeemer(row, payload.success) !== form.client_id || payload.success.resource !== resource)
									return null;
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
					agent: payload.success.agent,
					clientUrl: payload.success.client_url,
				} satisfies OAuthIdentity)
			: null;
	});
