import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { on } from "@comms/storage/dialect";
import { Cause, Clock, Crypto, Effect, Option, Ref, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type {
	Api,
	BackgroundContext,
	ManagedRequestContext,
} from "../../../packages/server/src/kernel/extension-api.ts";
import { makeAddressPolicy } from "./addresses.ts";
import type { OAuthIdentity } from "./oauth.ts";
import { messageUrl } from "./tools.ts";

/** Accept http:// and private callback addresses. Only for local development and tests, never on a public board. */
const allowLocalCallbacks = false;
const mentionEvent = "mention.created";
const messageEvent = "message.created";
type EventName = typeof mentionEvent | typeof messageEvent;
const defaultTtl = 24 * 60 * 60 * 1000;
const minimumTtl = 5 * 60 * 1000;
const verifiedFor = 24 * 60 * 60 * 1000;
const secretOverlap = 5 * 60 * 1000;
const maxAttempts = 5;
const perClient = 8;
const perBoard = 64;
const verificationsPerWindow = 10;
const verificationWindow = 10 * 60 * 1000;
const excerpt = 4000;
/** A replay delivers at most this many of the newest missed messages; `truncated` says an older one was skipped. */
const replayLimit = 100;
/** How many candidates a replay checks, the board's largest query page, so posts it would not deliver leave headroom. */
const replayScan = 200;
/**
 * An idle subscription moves its cursor to the board's event-fence head only once it trails by this many sequence
 * numbers. Every board request advances that fence, so moving on each one would cost a write per subscription per
 * request. A filtered page that has already scanned a later message still persists that message's sequence, so a
 * reload cannot re-emit an edit or move of something delivery already read.
 */
const idleCheckpoint = 1000;

const payloadSchema = {
	type: "object",
	properties: {
		id: { type: "string", description: "Message id accepted by the fetch tool." },
		topic: { type: "string" },
		author: { type: "string", description: "Agent name that posted the message." },
		text: { type: "string", description: `Message text, shortened to ${excerpt} characters.` },
		truncated: { type: "boolean" },
		url: { type: "string" },
	},
	required: ["id", "topic", "author", "text", "truncated", "url"],
	additionalProperties: false,
} as const;
const recursive = { type: "boolean", default: true, description: "Include the topic's subtopics." } as const;
const eventDefinitions = [
	{
		name: mentionEvent,
		description:
			"A published chirp message mentioned this connection's posting name (@name) or @here, optionally only within one topic. Posts made through this connection are not delivered. Call fetch with data.id for the full message.",
		delivery: ["webhook"],
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					minLength: 1,
					description: "Only mentions in this existing topic; omit for the whole board.",
				},
				recursive,
			},
			additionalProperties: false,
		},
		payloadSchema,
	},
	{
		name: messageEvent,
		description:
			"A message was published in the watched topic (and its subtopics unless recursive is false). Posts made through this connection are not delivered. Call fetch with data.id for the full message.",
		delivery: ["webhook"],
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					minLength: 1,
					description: "Existing topic path to watch, such as projects/chirp; an agent's home is @name.",
				},
				recursive,
			},
			required: ["topic"],
			additionalProperties: false,
		},
		payloadSchema,
	},
] as const;

type Failure = { readonly error: { readonly code: number; readonly message: string; readonly data?: object } };
const failure = (code: number, message: string, data?: object): Failure => ({
	error: { code, message, ...(data === undefined ? {} : { data }) },
});
const invalid = (reason: string) => failure(-32602, "Invalid params", { reason });

const SubscribeParams = Schema.Struct({
	name: Schema.String,
	arguments: Schema.optionalKey(Schema.Unknown),
	delivery: Schema.Struct({ mode: Schema.String, url: Schema.String, secret: Schema.String }),
	cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
	ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
const UnsubscribeParams = Schema.Struct({
	name: Schema.String,
	arguments: Schema.optionalKey(Schema.Unknown),
	delivery: Schema.Struct({ url: Schema.String }),
});
const Row = Schema.Struct({
	id: Schema.String,
	client_id: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	url: Schema.String,
	secret: Schema.String,
	previous_secret: Schema.NullOr(Schema.String),
	previous_secret_until: Schema.NullOr(Schema.Finite),
	refresh_before: Schema.Finite,
	verified_at: Schema.Finite,
	position: Schema.Finite,
	attempts: Schema.Finite,
	next_attempt: Schema.Finite,
	event_name: Schema.Literals([mentionEvent, messageEvent]),
	topic: Schema.NullOr(Schema.String),
	subtopics: Schema.Finite,
	incarnation: Schema.NullOr(Schema.String),
});
const Count = Schema.Array(Schema.Struct({ count: Schema.Finite }));
const Family = Schema.Array(Schema.Struct({ family: Schema.NullOr(Schema.String) }));
const Filter = Schema.Struct({
	topic: Schema.optionalKey(Schema.String),
	recursive: Schema.optionalKey(Schema.Boolean),
});
type Filter = typeof Filter.Type;
type Message = Effect.Success<ReturnType<BackgroundContext["messages"]["query"]>>["items"][number];
type Store = Pick<BackgroundContext, "db" | "read" | "mutate">;
type Rows = ReadonlyArray<typeof Row.Type>;

const isEvent = (name: string): name is EventName => name === mentionEvent || name === messageEvent;
const usage: Readonly<Record<EventName, string>> = {
	[mentionEvent]: `${mentionEvent} takes an optional topic and recursive`,
	[messageEvent]: `${messageEvent} takes a topic and an optional recursive`,
};
/**
 * message.created watches one topic; mention.created may narrow to one. Absent arguments are `{}`, and defaults are
 * dropped (recursive true, or recursive without a topic) so every spelling of one filter is one subscription.
 */
const filterOf = (name: EventName, value: unknown) =>
	Schema.decodeUnknownOption(Filter, { onExcessProperty: "error" })(value === undefined ? {} : value).pipe(
		Option.filter((filter) => filter.topic !== "" && (name === mentionEvent || filter.topic !== undefined)),
		Option.map((filter): Filter =>
			filter.topic === undefined
				? {}
				: filter.recursive === false
					? { topic: filter.topic, recursive: false }
					: { topic: filter.topic },
		),
	);
/** A cursor is the board sequence number delivery has passed, sent as a decimal string. */
const positionOf = (cursor: string) =>
	/^(0|[1-9][0-9]{0,15})$/.test(cursor) && Number.isSafeInteger(Number(cursor)) ? Number(cursor) : undefined;
const validSecret = (secret: string) => {
	const encoded = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret)?.[1];
	if (!encoded) return false;
	const key = Buffer.from(encoded, "base64");
	return key.length >= 24 && key.length <= 64 && key.toString("base64") === encoded;
};
const callbackUrl = (value: string) => {
	const url = URL.parse(value);
	return url &&
		value.length <= 2048 &&
		(url.protocol === "https:" || (allowLocalCallbacks && url.protocol === "http:")) &&
		!url.username &&
		!url.password
		? url
		: undefined;
};
/** Standard Webhooks v1: HMAC-SHA256 over `id.timestamp.body`, keyed by the decoded `whsec_` secret. */
const sign = (secret: string, id: string, timestamp: number, body: string) =>
	`v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64")}`;
const sameSecret = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};
/** Sign with the current key, and with the previous key during a secret-rotation overlap. */
const dualSign = (
	current: string,
	previous: string | null,
	previousUntil: number | null,
	now: number,
	id: string,
	timestamp: number,
	body: string,
) => {
	const latest = sign(current, id, timestamp, body);
	if (previous === null || previousUntil === null || now >= previousUntil || sameSecret(previous, current))
		return latest;
	return `${latest} ${sign(previous, id, timestamp, body)}`;
};
/**
 * Deterministic over client, callback, event and arguments. Arguments hash with sorted keys so their order never splits
 * a subscription, and `{}` hashes as it did before events took arguments, so those subscriptions keep their ids.
 */
const subscriptionId = (clientId: string, url: string, name: string, filter: Filter) =>
	`sub_${createHash("sha256")
		.update(
			JSON.stringify([
				clientId,
				url,
				name,
				Object.fromEntries(Object.entries(filter).toSorted(([left], [right]) => (left < right ? -1 : 1))),
			]),
		)
		.digest("hex")
		.slice(0, 32)}`;
/** The board query a subscription reads. The board ORs topic with mentions, so a mention filter's topic is applied after. */
const selection = (name: EventName, agent: string, topic: string | null, subtopics: boolean) =>
	name === messageEvent && topic !== null ? { topic, recursive: subtopics } : { mentions: [`@${agent}`, "@here"] };
/** Whether a message's topic is the subscription's topic, or under it when subtopics are included. */
const within = (topic: string | null, subtopics: boolean, candidate: string) =>
	topic === null || candidate === topic || (subtopics && candidate.startsWith(`${topic}/`));
/** The subscription's full delivery predicate: not this connection's grant posts, and inside its topic filter. */
const matches = (topic: string | null, subtopics: boolean, family: string | null, item: Message) =>
	item.instance !== family && within(topic, subtopics, item.topic);
/** Null-safe row-incarnation equality so a compare-and-swap cannot touch a recreated subscription. */
const sameIncarnation = (sql: Store["db"], incarnation: string | null) =>
	on(sql, {
		sqlite: () => sql`incarnation IS ${incarnation}`,
		pg: () => sql`incarnation IS NOT DISTINCT FROM ${incarnation}`,
		mysql: () => sql`incarnation <=> ${incarnation}`,
	});

type Sent =
	| { readonly status: "sent"; readonly code: number; readonly body: string }
	| { readonly status: "failed"; readonly reason: "connection_refused" | "timeout" | "tls_error" }
	| { readonly status: "suppressed" };
const reasonFor = (sent: Sent) =>
	sent.status === "failed"
		? sent.reason
		: sent.status === "sent" && sent.code >= 500
			? "http_5xx"
			: sent.status === "sent" && sent.code >= 400
				? "http_4xx"
				: "challenge_failed";

export const installEvents = (api: Api, origin: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const publicAddress = makeAddressPolicy();
		yield* api.migrate(
			"event_subscriptions",
			on(sql, {
				sqlite: () =>
					"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,refresh_before INTEGER NOT NULL,verified_at INTEGER NOT NULL,position INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,last_error TEXT)",
				pg: () =>
					"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error TEXT)",
				mysql: () =>
					"CREATE TABLE example_mcp_events(id VARCHAR(64) PRIMARY KEY,client_id VARCHAR(128) NOT NULL,agent VARCHAR(64) NOT NULL,instance VARCHAR(256) NOT NULL,url LONGTEXT NOT NULL,secret LONGTEXT NOT NULL,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
			}),
			{
				protect: true,
				alternateStatements: [
					on(sql, {
						sqlite: () =>
							"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,previous_secret TEXT,previous_secret_until INTEGER,refresh_before INTEGER NOT NULL,verified_at INTEGER NOT NULL,position INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,last_error TEXT)",
						pg: () =>
							"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,previous_secret TEXT,previous_secret_until BIGINT,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error TEXT)",
						mysql: () =>
							"CREATE TABLE example_mcp_events(id VARCHAR(64) PRIMARY KEY,client_id VARCHAR(128) NOT NULL,agent VARCHAR(64) NOT NULL,instance VARCHAR(256) NOT NULL,url LONGTEXT NOT NULL,secret LONGTEXT NOT NULL,previous_secret LONGTEXT,previous_secret_until BIGINT,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
					}),
				],
			},
		);
		// Secret rotation came after boards had created the table, so it is added by later steps rather than by
		// editing the first one: a changed migration is refused as extension_migration_conflict on those boards.
		// Boards that installed MCP from master/canary after #60 merged have both columns in the CREATE already;
		// skipIfColumnExists makes these migrations safe for both original and intermediate states.
		yield* api.migrate(
			"event_previous_secret",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret TEXT",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret TEXT",
				mysql: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret LONGTEXT",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "previous_secret" } },
		);
		yield* api.migrate(
			"event_previous_secret_until",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret_until INTEGER",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret_until BIGINT",
				mysql: () => "ALTER TABLE example_mcp_events ADD COLUMN previous_secret_until BIGINT",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "previous_secret_until" } },
		);
		// Topic watches came later still, so they are added the same way. The defaults keep every earlier row a
		// mention.created subscription over the whole board.
		yield* api.migrate(
			"event_name",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN event_name TEXT NOT NULL DEFAULT 'mention.created'",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN event_name TEXT NOT NULL DEFAULT 'mention.created'",
				mysql: () =>
					"ALTER TABLE example_mcp_events ADD COLUMN event_name VARCHAR(32) NOT NULL DEFAULT 'mention.created'",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "event_name" } },
		);
		yield* api.migrate(
			"event_topic",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN topic TEXT",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN topic TEXT",
				mysql: () => "ALTER TABLE example_mcp_events ADD COLUMN topic VARCHAR(256)",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "topic" } },
		);
		yield* api.migrate(
			"event_subtopics",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN subtopics INTEGER NOT NULL DEFAULT 1",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN subtopics INTEGER NOT NULL DEFAULT 1",
				mysql: () => "ALTER TABLE example_mcp_events ADD COLUMN subtopics INTEGER NOT NULL DEFAULT 1",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "subtopics" } },
		);
		// Each insert names its row with a random incarnation, so delivery's in-memory read point applies only to the
		// row it was made for. Rows from before have none, which is still theirs alone.
		yield* api.migrate(
			"event_incarnation",
			on(sql, {
				sqlite: () => "ALTER TABLE example_mcp_events ADD COLUMN incarnation TEXT",
				pg: () => "ALTER TABLE example_mcp_events ADD COLUMN incarnation TEXT",
				mysql: () => "ALTER TABLE example_mcp_events ADD COLUMN incarnation VARCHAR(32)",
			}),
			{ skipIfColumnExists: { table: "example_mcp_events", column: "incarnation" } },
		);
		const rows = (ctx: Store, clientId?: string) =>
			ctx.read(() =>
				(clientId === undefined
					? ctx.db`SELECT * FROM example_mcp_events ORDER BY id`
					: ctx.db`SELECT * FROM example_mcp_events WHERE client_id=${clientId} ORDER BY id`
				).pipe(Effect.flatMap(decodeRows)),
			);
		const count = (ctx: Store, query: (sql: Store["db"]) => Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
			ctx.read(() => query(ctx.db).pipe(Effect.flatMap(decodeCount)));
		const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
		const decodeCount = (result: ReadonlyArray<unknown>) =>
			Schema.decodeUnknownEffect(Count)(result).pipe(Effect.map((items) => items[0]?.count ?? 0));
		// Verification makes the board contact a client-chosen host, and a replay re-sends history to it, so each client
		// gets a small budget for both.
		const verifications = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());
		// How far each subscription has read in this generation. Kept in memory so an idle subscription need not write
		// its position on every board request, yet never reads a message twice: an edit or topic move keeps a message's
		// sequence number, and a second read would deliver it as new. Each entry names the row incarnation and posting
		// name it was read for, and only drains write it, one cycle after another, so neither a re-created row nor one
		// re-consented under another name inherits a read point taken for something else.
		const scanned = yield* Ref.make<
			ReadonlyMap<string, { readonly incarnation: string | null; readonly agent: string; readonly through: number }>
		>(new Map());
		// Consecutive drain failures per subscription in this generation, for its back-off.
		const failures = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
		const random = (size: number) =>
			crypto.randomBytes(size).pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));

		/**
		 * Connect only to an address that was checked at send time, keeping the hostname for SNI and certificate checks,
		 * so DNS rebinding cannot redirect a verified callback to a private address. Redirects are never followed.
		 */
		const send = (
			target: URL,
			subscription: string,
			secret: string,
			previousSecret: string | null,
			previousUntil: number | null,
			id: string,
			body: string,
		) =>
			Effect.gen(function* () {
				const hostname = target.hostname.replace(/^\[|\]$/g, "");
				const lookedUp = yield* Effect.tryPromise(() => lookup(hostname, { all: true, verbatim: true })).pipe(
					Effect.timeoutOption("5 seconds"),
					Effect.orElseSucceed(() => Option.some([])),
				);
				if (Option.isNone(lookedUp)) return { status: "failed", reason: "timeout" } satisfies Sent;
				const resolved = lookedUp.value;
				const address = resolved[0];
				if (!address || (!allowLocalCallbacks && resolved.some((item) => !publicAddress(item.address))))
					return { status: "failed", reason: "connection_refused" } satisfies Sent;
				const pinned = new URL(target.href);
				pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
				const now = yield* Clock.currentTimeMillis;
				const timestamp = Math.floor(now / 1000);
				const request = HttpClientRequest.post(pinned.href).pipe(
					HttpClientRequest.bodyText(body, "application/json"),
					HttpClientRequest.setHeaders({
						host: target.host,
						"webhook-id": id,
						"webhook-timestamp": String(timestamp),
						"webhook-signature": dualSign(secret, previousSecret, previousUntil, now, id, timestamp, body),
						"x-mcp-subscription-id": subscription,
					}),
				);
				const init: BunFetchRequestInit = {
					redirect: "manual",
					credentials: "omit",
					...(target.protocol === "https:"
						? {
								tls: {
									...(isIP(hostname) === 0 ? { serverName: hostname } : {}),
									checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
								},
							}
						: {}),
				};
				const outcome = yield* api.effects
					.fetch(request, (response) =>
						Effect.gen(function* () {
							const chunks: Array<Uint8Array> = [];
							let size = 0;
							yield* response.stream.pipe(
								Stream.takeWhile(() => size <= 65536),
								Stream.runForEach((chunk) =>
									Effect.sync(() => {
										size += chunk.byteLength;
										chunks.push(chunk);
									}),
								),
							);
							return { code: response.status, body: Buffer.concat(chunks).toString("utf8").slice(0, 65536) };
						}),
					)
					.pipe(
						Effect.provideService(FetchHttpClient.RequestInit, init),
						Effect.timeoutOption("10 seconds"),
						Effect.exit,
					);
				if (outcome._tag === "Failure") {
					if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
					return {
						status: "failed",
						reason: /cert|tls|ssl/i.test(Cause.pretty(outcome.cause)) ? "tls_error" : "connection_refused",
					} satisfies Sent;
				}
				if (outcome.value._tag === "None") return { status: "failed", reason: "timeout" } satisfies Sent;
				const response = outcome.value.value;
				return response.status === "suppressed"
					? ({ status: "suppressed" } satisfies Sent)
					: ({ status: "sent", ...response.value } satisfies Sent);
			});

		const verify = (target: URL, subscription: string, secret: string) =>
			Effect.gen(function* () {
				const challenge = yield* random(24);
				const sent = yield* send(
					target,
					subscription,
					secret,
					null,
					null,
					`msg_verification_${yield* random(12)}`,
					JSON.stringify({ type: "verification", challenge }),
				);
				if (sent.status !== "sent" || sent.code < 200 || sent.code > 299) return reasonFor(sent);
				const echoed = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Struct({ challenge: Schema.String })),
				)(sent.body).pipe(Effect.option);
				const expected = Buffer.from(challenge);
				const received = Buffer.from(echoed._tag === "Some" ? echoed.value.challenge : "");
				return received.length === expected.length && timingSafeEqual(received, expected) ? null : "challenge_failed";
			});

		const subscribe = (
			ctx: Store & Pick<ManagedRequestContext, "extension" | "topics" | "messages">,
			caller: OAuthIdentity,
			params: unknown,
		) =>
			Effect.gen(function* () {
				const decoded = Schema.decodeUnknownOption(SubscribeParams)(params);
				if (decoded._tag === "None")
					return invalid(
						"name, delivery.mode, delivery.url and delivery.secret are required; cursor is a string or null",
					);
				const input = decoded.value;
				const name = input.name;
				if (!isEvent(name)) return failure(-32011, "NotFound", { kind: "event" });
				if (input.delivery.mode !== "webhook")
					return failure(-32014, "Unsupported", { feature: "deliveryMode", value: input.delivery.mode });
				const filter = filterOf(name, input.arguments);
				if (Option.isNone(filter)) return invalid(usage[name]);
				const cursor = input.cursor === undefined || input.cursor === null ? null : positionOf(input.cursor);
				if (cursor === undefined) return invalid("cursor must be null or a cursor this server sent");
				if (!validSecret(input.delivery.secret))
					return invalid("delivery.secret must be whsec_ and 24–64 base64 bytes");
				const target = callbackUrl(input.delivery.url);
				if (!target) return invalid("delivery.url must be an https URL without credentials");
				const agent = caller.agent;
				if (!caller.scopes.includes("read") || !agent)
					return failure(-32012, "Forbidden", { reason: "Reconnect with write access to choose the name to watch." });
				const topic = filter.value.topic ?? null;
				if (topic !== null) {
					const missing = yield* ctx.topics.read(topic, { depth: 0 }).pipe(
						Effect.as(null),
						Effect.catchTag("KernelError", (error) =>
							error.code === "topic_not_found" || error.code === "input_invalid"
								? Effect.succeed(error.code)
								: Effect.fail(error),
						),
						// The topic view also reads the topic's pages, which refuse some valid topic names such as node_modules.
						Effect.catchTag("PageRejected", (error) => Effect.succeed(error.code)),
					);
					if (missing === "input_invalid" || missing === "page_path_invalid")
						return invalid("topic must be a board topic path that can be read");
					if (missing === "topic_not_found") return failure(-32011, "NotFound", { kind: "topic", topic });
					// The page store was unavailable or changed under the read, so the topic may exist: the client retries.
					if (missing !== null) return failure(-32603, "Internal error", { retriable: true, reason: missing });
				}
				const id = subscriptionId(caller.clientId, target.href, name, filter.value);
				const now = yield* Clock.currentTimeMillis;
				const ttl = input.ttlMs === undefined || input.ttlMs === null ? defaultTtl : input.ttlMs;
				const refreshBefore = now + Math.min(defaultTtl, Math.max(minimumTtl, ttl));
				const instance = `extension:${ctx.extension}:${caller.clientId}`;
				const owned = yield* rows(ctx, caller.clientId);
				// Verification is cached per client and callback, so differing arguments cannot multiply challenges.
				const cached = owned
					.filter((row) => row.url === target.href && row.refresh_before > now && row.verified_at > now - verifiedFor)
					.toSorted((left, right) => right.verified_at - left.verified_at)[0];
				const fence = yield* ctx.read((value) => Effect.succeed(value));
				// A new subscription starts now, or after the client's cursor; a cursor beyond the board starts now.
				const since = cursor === null ? fence : Math.min(cursor, fence);
				// Only a replay that creates a row spends the budget below; a refresh keeps its position.
				const replaying = since < fence && !owned.some((row) => row.id === id && row.refresh_before > now);
				if (!cached || replaying) {
					const allowed = yield* Ref.modify(verifications, (budget) => {
						const recent = (budget.get(caller.clientId) ?? []).filter((at) => at > now - verificationWindow);
						const next = new Map(budget);
						next.set(caller.clientId, recent.length < verificationsPerWindow ? [...recent, now] : recent);
						return [recent.length < verificationsPerWindow, next] as const;
					});
					if (!allowed)
						return failure(-32013, "ResourceExhausted", { limit: "verifications", max: verificationsPerWindow });
				}
				if (!cached) {
					const reason = yield* verify(target, id, input.delivery.secret);
					if (reason !== null) return failure(-32015, "CallbackEndpointError", { reason });
				}
				const verifiedAt = cached?.verified_at ?? now;
				// A replay is bounded by the messages it would deliver, not by board sequence numbers. It is worked out
				// whenever the client is behind, even on a refresh, because the row can expire before the mutation below.
				const subtopics = filter.value.recursive !== false;
				const window =
					since < fence
						? yield* ctx.messages.query({
								since,
								newest: true,
								limit: replayScan,
								exclude: instance,
								...selection(name, agent, topic, subtopics),
							})
						: undefined;
				const family =
					window === undefined || window.items.length === 0 ? null : yield* grantFamily(ctx, caller.clientId, agent);
				const matched = (window?.items ?? []).filter((item) => matches(topic, subtopics, family, item));
				// Past the newest replayLimit matches it starts after the one just older. A full window of candidates starts
				// at its oldest, and is truncated if an older match exists or older candidates were left unexamined.
				const over = matched.length > replayLimit ? matched[matched.length - replayLimit - 1] : undefined;
				const oldest =
					over === undefined && window !== undefined && window.items.length === replayScan
						? window.items[0]
						: undefined;
				// Truncation looks at one older page, the same 200-candidate bound as the newest window. A full page
				// that ends before oldest may still meet it; the next page is truncated only when a match is in that gap.
				const older =
					oldest === undefined
						? false
						: yield* Effect.gen(function* () {
								const page = yield* ctx.messages.query({
									since,
									limit: replayScan,
									exclude: instance,
									...selection(name, agent, topic, subtopics),
								});
								if (page.items.some((item) => item.seq < oldest.seq && matches(topic, subtopics, family, item)))
									return true;
								const last = page.items.at(-1);
								if (last === undefined || last.seq >= oldest.seq || page.items.length < replayScan) return false;
								const next = yield* ctx.messages.query({
									since: last.seq,
									limit: replayScan,
									exclude: instance,
									...selection(name, agent, topic, subtopics),
								});
								return next.items.some((item) => item.seq < oldest.seq && matches(topic, subtopics, family, item));
							});
				const start =
					over !== undefined
						? { position: over.seq, truncated: true }
						: oldest !== undefined
							? { position: oldest.seq - 1, truncated: older }
							: { position: since, truncated: false };
				const incarnation = yield* random(8);
				const sql = ctx.db;
				// Mutations serialize on the board's writer lock, so the existence and limit checks cannot race.
				const outcome = yield* ctx.mutate(
					Effect.gen(function* () {
						yield* sql`DELETE FROM example_mcp_events WHERE refresh_before<=${now}`;
						const current: Rows = yield* sql`SELECT * FROM example_mcp_events WHERE id=${id}`.pipe(
							Effect.flatMap(decodeRows),
						);
						const existing = current[0];
						// A live subscription keeps its own position: whatever cursor the refresh carries is at or behind it.
						if (existing) {
							const rotating = !sameSecret(existing.secret, input.delivery.secret);
							const previous = rotating ? existing.secret : existing.previous_secret;
							const previousUntil = rotating ? now + secretOverlap : existing.previous_secret_until;
							const resetRetries = existing.agent !== agent ? 0 : existing.attempts;
							yield* sql`UPDATE example_mcp_events SET agent=${agent},previous_secret=${previous},previous_secret_until=${previousUntil},secret=${input.delivery.secret},refresh_before=${refreshBefore},verified_at=${verifiedAt},attempts=${resetRetries},next_attempt=0 WHERE id=${id}`;
							return { position: existing.position, truncated: false };
						}
						const clientCount =
							yield* sql`SELECT COUNT(*) AS count FROM example_mcp_events WHERE client_id=${caller.clientId}`.pipe(
								Effect.flatMap(decodeCount),
							);
						if (clientCount >= perClient) return { limit: perClient };
						const boardCount = yield* sql`SELECT COUNT(*) AS count FROM example_mcp_events`.pipe(
							Effect.flatMap(decodeCount),
						);
						if (boardCount >= perBoard) return { limit: perBoard };
						yield* sql`INSERT INTO example_mcp_events(id,client_id,agent,instance,url,secret,previous_secret,previous_secret_until,refresh_before,verified_at,position,attempts,next_attempt,last_error,event_name,topic,subtopics,incarnation) VALUES(${id},${caller.clientId},${agent},${instance},${target.href},${input.delivery.secret},NULL,NULL,${refreshBefore},${verifiedAt},${start.position},0,0,NULL,${name},${topic},${subtopics ? 1 : 0},${incarnation})`;
						return start;
					}),
				);
				if ("limit" in outcome)
					return failure(-32013, "ResourceExhausted", { limit: "subscriptions", max: outcome.limit });
				return {
					result: {
						id,
						refreshBefore: new Date(refreshBefore).toISOString(),
						cursor: String(outcome.position),
						truncated: outcome.truncated,
					},
				};
			});

		const unsubscribe = (ctx: Store, caller: OAuthIdentity, params: unknown) =>
			Effect.gen(function* () {
				const decoded = Schema.decodeUnknownOption(UnsubscribeParams)(params);
				if (decoded._tag === "None") return invalid("name and delivery.url are required");
				const input = decoded.value;
				const name = input.name;
				if (!isEvent(name)) return failure(-32011, "NotFound", { kind: "event" });
				const filter = filterOf(name, input.arguments);
				if (Option.isNone(filter)) return invalid(usage[name]);
				const target = callbackUrl(input.delivery.url);
				if (!target) return invalid("delivery.url must be an https URL without credentials");
				const id = subscriptionId(caller.clientId, target.href, name, filter.value);
				yield* ctx.mutate(ctx.db`DELETE FROM example_mcp_events WHERE id=${id} AND client_id=${caller.clientId}`);
				return { result: {} };
			});

		/** A subscription lives only while its client still holds an unexpired grant. */
		const granted = (ctx: Store, clientId: string, now: number) =>
			count(
				ctx,
				(sql) =>
					sql`SELECT COUNT(*) AS count FROM example_mcp_oauth WHERE client_id=${clientId} AND (kind='access' OR kind='refresh') AND expires_at>${now}`,
			).pipe(Effect.map((total) => total > 0));

		/** The subscription's grant family: the row for this client and posting name, not a later re-consent. */
		const grantFamily = (ctx: Store, clientId: string, agent: string) =>
			ctx
				.read(() =>
					ctx.db`SELECT family FROM example_mcp_grants WHERE client_id=${clientId} AND agent=${agent}`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Family)),
					),
				)
				.pipe(Effect.map((found) => found[0]?.family ?? null));

		const deliver = (row: typeof Row.Type, message: Message) =>
			Effect.gen(function* () {
				// Subscription id plus sequence: the same post on two subscriptions is two deliveries, and a retry
				// of one subscription keeps the same Standard Webhooks id.
				const eventId = `evt_${row.id}_${message.seq}`;
				const body = JSON.stringify({
					eventId,
					name: row.event_name,
					timestamp: new Date(message.created_at).toISOString(),
					data: {
						id: `message:${message.seq}`,
						topic: message.topic,
						author: message.agent,
						text: message.body.slice(0, excerpt),
						truncated: message.body.length > excerpt,
						url: messageUrl(origin, message.seq),
					},
					// Delivery is in order, so everything up to this message has been delivered or given up on.
					cursor: String(message.seq),
				});
				const target = callbackUrl(row.url);
				if (!target) return "rejected" as const;
				const sent = yield* send(
					target,
					row.id,
					row.secret,
					row.previous_secret,
					row.previous_secret_until,
					eventId,
					body,
				);
				if (sent.status === "suppressed") return "suppressed" as const;
				if (sent.status === "sent" && sent.code >= 200 && sent.code < 300) return "delivered" as const;
				if (sent.status === "sent" && (sent.code === 410 || sent.code === 413)) return "rejected" as const;
				return reasonFor(sent);
			});

		const checkpoint = (
			ctx: Store,
			id: string,
			agent: string,
			incarnation: string | null,
			from: number,
			to: number,
			attempts: number,
			next: number,
			error: string | null,
		) =>
			ctx.mutate(
				ctx.db`UPDATE example_mcp_events SET position=${to},attempts=${attempts},next_attempt=${next},last_error=${error} WHERE id=${id} AND agent=${agent} AND position=${from} AND ${sameIncarnation(ctx.db, incarnation)}`,
			);

		/** Live row at this cursor and incarnation, or none if it was deleted, expired, moved, or recreated. */
		const live = (ctx: Store, id: string, from: number, now: number, incarnation: string | null) =>
			ctx
				.read(() =>
					ctx.db`SELECT * FROM example_mcp_events WHERE id=${id} AND position=${from} AND refresh_before>${now} AND ${sameIncarnation(ctx.db, incarnation)}`.pipe(
						Effect.flatMap(decodeRows),
					),
				)
				.pipe(Effect.map((found) => found[0]));

		/** Delivers one subscription's pending events in order; says when to look again and whether more remain. */
		const drain = (ctx: BackgroundContext, row: typeof Row.Type, now: number) =>
			Effect.gen(function* () {
				if (row.next_attempt > now) return { wake: row.next_attempt, backlog: false };
				if (!(yield* granted(ctx, row.client_id, now))) {
					yield* ctx.mutate(
						Effect.gen(function* () {
							const grantCount =
								yield* ctx.db`SELECT COUNT(*) AS count FROM example_mcp_oauth WHERE client_id=${row.client_id} AND (kind='access' OR kind='refresh') AND expires_at>${now}`.pipe(
									Effect.flatMap(decodeCount),
								);
							if (grantCount === 0) {
								yield* ctx.db`DELETE FROM example_mcp_events WHERE id=${row.id} AND ${sameIncarnation(ctx.db, row.incarnation)}`;
							}
						}),
					);
					return { wake: Infinity, backlog: false };
				}
				// A read point counts only for the row incarnation and posting name it was made for; otherwise the row starts at
				// its own position, which delivery never moves past a scan made for another name.
				const mark = (yield* Ref.get(scanned)).get(row.id);
				const page = yield* ctx.messages.query({
					since: Math.max(
						row.position,
						mark !== undefined && mark.incarnation === row.incarnation && mark.agent === row.agent ? mark.through : 0,
					),
					...selection(row.event_name, row.agent, row.topic, row.subtopics === 1),
					exclude: row.instance,
					limit: 16,
				});
				const family = page.items.length === 0 ? null : yield* grantFamily(ctx, row.client_id, row.agent);
				let position = row.position;
				let attempts = row.attempts;
				for (const message of page.items.filter((item) => matches(row.topic, row.subtopics === 1, family, item))) {
					const at = yield* Clock.currentTimeMillis;
					const current = yield* live(ctx, row.id, position, at, row.incarnation);
					// Stop if unsubscribe, expiry, grant loss, agent change, recreate, or another drain moved the cursor.
					if (!current || !(yield* granted(ctx, current.client_id, at)) || current.agent !== row.agent)
						return { wake: Infinity, backlog: false };
					const outcome = message.deleted_at === null ? yield* deliver(current, message) : "rejected";
					// Suppressed means this generation is no longer live; its scope is about to close.
					if (outcome === "suppressed") return { wake: now + 1000, backlog: false };
					attempts = outcome === "delivered" || outcome === "rejected" ? 0 : attempts + 1;
					if (attempts > 0 && attempts < maxAttempts) {
						const failedAt = yield* Clock.currentTimeMillis;
						const next = failedAt + Math.min(300_000, 10_000 * 2 ** (attempts - 1));
						yield* checkpoint(ctx, row.id, row.agent, row.incarnation, position, position, attempts, next, outcome);
						return { wake: next, backlog: false };
					}
					// Delivered, refused with 410 or 413, or out of attempts: move past this message.
					const error = attempts === 0 ? null : outcome;
					attempts = 0;
					yield* checkpoint(ctx, row.id, row.agent, row.incarnation, position, message.seq, 0, 0, error);
					position = message.seq;
				}
				// Past what this page scanned. Empty pages write the event fence only once the gap is large, but they
				// still persist once a later message exists so a reload cannot re-read an edit or move.
				if (page.cursor > position) {
					const persistFence = page.items.length > 0 || page.cursor - position >= idleCheckpoint;
					const newest = persistFence
						? undefined
						: (yield* ctx.messages.query({ since: position, newest: true, limit: 1 })).items[0];
					// The unfiltered newest read can see a message published after this page; never persist past the
					// fence that page actually scanned, or a matching post in that gap is skipped forever.
					const to = persistFence ? page.cursor : newest !== undefined ? Math.min(newest.seq, page.cursor) : undefined;
					if (to !== undefined && to > position) {
						const at = yield* Clock.currentTimeMillis;
						const current = yield* live(ctx, row.id, position, at, row.incarnation);
						if (current && current.agent === row.agent) {
							yield* checkpoint(ctx, row.id, row.agent, row.incarnation, position, to, 0, 0, null);
							position = to;
						}
					}
				}
				// Remember how far this page read. A drain of a replaced or re-consented row ends in an earlier cycle than the
				// next drain of the row as it is now, which ignores this entry because the incarnation or name differs.
				yield* Ref.update(scanned, (map) =>
					new Map(map).set(row.id, { incarnation: row.incarnation, agent: row.agent, through: page.cursor }),
				);
				return { wake: now + 60_000, backlog: page.items.length === 16 };
			});

		/**
		 * One subscription's failure backs off only that subscription, from two seconds doubling to a minute, so a
		 * transient board error delays it briefly while the others keep delivering.
		 */
		const isolated = (ctx: BackgroundContext, row: typeof Row.Type, now: number) =>
			drain(ctx, row, now).pipe(
				Effect.exit,
				Effect.flatMap((exit) =>
					Effect.gen(function* () {
						if (exit._tag === "Success") {
							// A drain still waiting out its back-off returned early, so only one that ran clears the count.
							if (row.next_attempt <= now)
								yield* Ref.update(failures, (map) =>
									map.has(row.id) ? new Map([...map].filter(([key]) => key !== row.id)) : map,
								);
							return exit.value;
						}
						if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
						const failed = yield* Ref.modify(failures, (map) => {
							const count = (map.get(row.id) ?? 0) + 1;
							return [count, new Map(map).set(row.id, count)] as const;
						});
						const wake = (yield* Clock.currentTimeMillis) + Math.min(60_000, 2_000 * 2 ** (failed - 1));
						yield* ctx
							.mutate(
								ctx.db`UPDATE example_mcp_events SET next_attempt=${wake},last_error='drain_failed' WHERE id=${row.id} AND position=${row.position} AND agent=${row.agent} AND ${sameIncarnation(ctx.db, row.incarnation)}`,
							)
							.pipe(Effect.ignore);
						return { wake, backlog: false };
					}),
				),
			);

		/** Messages are read through the public message query, so delivery sees exactly what the board has published. */
		const run = (ctx: BackgroundContext) =>
			Effect.gen(function* () {
				while (true) {
					const cycle = yield* Effect.gen(function* () {
						const fence = yield* ctx.read((value) => Effect.succeed(value));
						const now = yield* Clock.currentTimeMillis;
						yield* ctx.mutate(ctx.db`DELETE FROM example_mcp_events WHERE refresh_before<=${now}`);
						// Subscriptions drain concurrently so one slow callback cannot hold up the others.
						const current = yield* rows(ctx);
						// Entries for subscriptions that expired, lost their grant or were unsubscribed go with them.
						const ids = new Set(current.map((row) => row.id));
						yield* Ref.update(scanned, (map) => new Map([...map].filter(([id]) => ids.has(id))));
						yield* Ref.update(failures, (map) => new Map([...map].filter(([id]) => ids.has(id))));
						const results = yield* Effect.forEach(current, (row) => isolated(ctx, row, now), {
							concurrency: 8,
						});
						if (results.some((result) => result.backlog)) return;
						const wake = Math.min(now + 60_000, ...results.map((result) => result.wake));
						yield* Effect.raceFirst(
							ctx.events.changed(fence),
							Effect.sleep(Math.max(0, wake - (yield* Clock.currentTimeMillis))),
						);
					}).pipe(Effect.exit);
					if (cycle._tag === "Failure") {
						if (Cause.hasInterruptsOnly(cycle.cause)) return yield* Effect.interrupt;
						yield* Effect.sleep("1 second");
					}
				}
			});

		api.on("start", (event: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
			event.reason === "live" ? run(ctx).pipe(Effect.forkScoped, Effect.asVoid) : Effect.void,
		);
		return { list: { events: eventDefinitions }, subscribe, unsubscribe };
	});
