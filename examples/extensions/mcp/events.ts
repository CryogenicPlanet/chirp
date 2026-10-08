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

const eventDefinitions = [
	{
		name: mentionEvent,
		description:
			"A published chirp message mentioned this connection's posting name (@name) or @here. Posts made through this connection are not delivered. Call fetch with data.id for the full message.",
		delivery: ["webhook"],
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		payloadSchema: {
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
		},
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
	ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
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
});
const Count = Schema.Array(Schema.Struct({ count: Schema.Finite }));
type Message = Effect.Success<ReturnType<BackgroundContext["messages"]["query"]>>["items"][number];
type Store = Pick<BackgroundContext, "db" | "read" | "mutate">;
type Rows = ReadonlyArray<typeof Row.Type>;

/** Only an absent or empty `arguments` object is valid: the event has no filters. */
const noArguments = (value: unknown) =>
	value === undefined ||
	(typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
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
const subscriptionId = (clientId: string, url: string, name: string) =>
	`sub_${createHash("sha256")
		.update(JSON.stringify([clientId, url, name, {}]))
		.digest("hex")
		.slice(0, 32)}`;

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
					"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,previous_secret TEXT,previous_secret_until INTEGER,refresh_before INTEGER NOT NULL,verified_at INTEGER NOT NULL,position INTEGER NOT NULL,attempts INTEGER NOT NULL,next_attempt INTEGER NOT NULL,last_error TEXT)",
				pg: () =>
					"CREATE TABLE example_mcp_events(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,previous_secret TEXT,previous_secret_until BIGINT,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error TEXT)",
				mysql: () =>
					"CREATE TABLE example_mcp_events(id VARCHAR(64) PRIMARY KEY,client_id VARCHAR(128) NOT NULL,agent VARCHAR(64) NOT NULL,instance VARCHAR(256) NOT NULL,url LONGTEXT NOT NULL,secret LONGTEXT NOT NULL,previous_secret LONGTEXT,previous_secret_until BIGINT,refresh_before BIGINT NOT NULL,verified_at BIGINT NOT NULL,position BIGINT NOT NULL,attempts INTEGER NOT NULL,next_attempt BIGINT NOT NULL,last_error VARCHAR(32)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
			}),
			{ protect: true },
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
		// Verification makes the board contact a client-chosen host, so each client gets a small budget.
		const verifications = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());
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

		const subscribe = (ctx: Store & Pick<ManagedRequestContext, "extension">, caller: OAuthIdentity, params: unknown) =>
			Effect.gen(function* () {
				const decoded = Schema.decodeUnknownOption(SubscribeParams)(params);
				if (decoded._tag === "None")
					return invalid("name, delivery.mode, delivery.url and delivery.secret are required");
				const input = decoded.value;
				if (input.name !== mentionEvent) return failure(-32011, "NotFound", { kind: "event" });
				if (input.delivery.mode !== "webhook")
					return failure(-32014, "Unsupported", { feature: "deliveryMode", value: input.delivery.mode });
				if (!noArguments(input.arguments)) return invalid(`${mentionEvent} takes no arguments`);
				if (!validSecret(input.delivery.secret))
					return invalid("delivery.secret must be whsec_ and 24–64 base64 bytes");
				const target = callbackUrl(input.delivery.url);
				if (!target) return invalid("delivery.url must be an https URL without credentials");
				const agent = caller.agent;
				if (!caller.scopes.includes("read") || !agent)
					return failure(-32012, "Forbidden", { reason: "Reconnect with write access to choose the name to watch." });
				const id = subscriptionId(caller.clientId, target.href, input.name);
				const now = yield* Clock.currentTimeMillis;
				const ttl = input.ttlMs === undefined || input.ttlMs === null ? defaultTtl : input.ttlMs;
				const refreshBefore = now + Math.min(defaultTtl, Math.max(minimumTtl, ttl));
				const cached = (yield* rows(ctx, caller.clientId)).find(
					(row) => row.id === id && row.refresh_before > now && row.verified_at > now - verifiedFor,
				);
				if (!cached) {
					const allowed = yield* Ref.modify(verifications, (budget) => {
						const recent = (budget.get(caller.clientId) ?? []).filter((at) => at > now - verificationWindow);
						const next = new Map(budget);
						next.set(caller.clientId, recent.length < verificationsPerWindow ? [...recent, now] : recent);
						return [recent.length < verificationsPerWindow, next] as const;
					});
					if (!allowed)
						return failure(-32013, "ResourceExhausted", { limit: "verifications", max: verificationsPerWindow });
					const reason = yield* verify(target, id, input.delivery.secret);
					if (reason !== null) return failure(-32015, "CallbackEndpointError", { reason });
				}
				const verifiedAt = cached?.verified_at ?? now;
				const start = yield* ctx.read((fence) => Effect.succeed(fence));
				const sql = ctx.db;
				// Mutations serialize on the board's writer lock, so the existence and limit checks cannot race.
				const full = yield* ctx.mutate(
					Effect.gen(function* () {
						yield* sql`DELETE FROM example_mcp_events WHERE refresh_before<=${now}`;
						const current: Rows = yield* sql`SELECT * FROM example_mcp_events WHERE id=${id}`.pipe(
							Effect.flatMap(decodeRows),
						);
						if (current.length > 0) {
							const existing = current[0];
							if (!existing) return null;
							const rotating = !sameSecret(existing.secret, input.delivery.secret);
							const previous = rotating ? existing.secret : existing.previous_secret;
							const previousUntil = rotating ? now + secretOverlap : existing.previous_secret_until;
							yield* sql`UPDATE example_mcp_events SET agent=${agent},previous_secret=${previous},previous_secret_until=${previousUntil},secret=${input.delivery.secret},refresh_before=${refreshBefore},verified_at=${verifiedAt},next_attempt=0 WHERE id=${id}`;
							return null;
						}
						const clientCount =
							yield* sql`SELECT COUNT(*) AS count FROM example_mcp_events WHERE client_id=${caller.clientId}`.pipe(
								Effect.flatMap(decodeCount),
							);
						if (clientCount >= perClient) return perClient;
						const boardCount = yield* sql`SELECT COUNT(*) AS count FROM example_mcp_events`.pipe(
							Effect.flatMap(decodeCount),
						);
						if (boardCount >= perBoard) return perBoard;
						yield* sql`INSERT INTO example_mcp_events(id,client_id,agent,instance,url,secret,previous_secret,previous_secret_until,refresh_before,verified_at,position,attempts,next_attempt,last_error) VALUES(${id},${caller.clientId},${agent},${`extension:${ctx.extension}:${caller.clientId}`},${target.href},${input.delivery.secret},NULL,NULL,${refreshBefore},${verifiedAt},${start},0,0,NULL)`;
						return null;
					}),
				);
				if (full !== null) return failure(-32013, "ResourceExhausted", { limit: "subscriptions", max: full });
				return {
					result: { id, refreshBefore: new Date(refreshBefore).toISOString(), cursor: null, truncated: false },
				};
			});

		const unsubscribe = (ctx: Store, caller: OAuthIdentity, params: unknown) =>
			Effect.gen(function* () {
				const decoded = Schema.decodeUnknownOption(UnsubscribeParams)(params);
				if (decoded._tag === "None") return invalid("name and delivery.url are required");
				if (decoded.value.name !== mentionEvent) return failure(-32011, "NotFound", { kind: "event" });
				const target = callbackUrl(decoded.value.delivery.url);
				if (!target) return invalid("delivery.url must be an https URL without credentials");
				const id = subscriptionId(caller.clientId, target.href, decoded.value.name);
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

		const deliver = (row: typeof Row.Type, message: Message) =>
			Effect.gen(function* () {
				const eventId = `evt_${message.seq}`;
				const body = JSON.stringify({
					eventId,
					name: mentionEvent,
					timestamp: new Date(message.created_at).toISOString(),
					data: {
						id: `message:${message.seq}`,
						topic: message.topic,
						author: message.agent,
						text: message.body.slice(0, excerpt),
						truncated: message.body.length > excerpt,
						url: messageUrl(origin, message.seq),
					},
					cursor: null,
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
			from: number,
			to: number,
			attempts: number,
			next: number,
			error: string | null,
		) =>
			ctx.mutate(
				ctx.db`UPDATE example_mcp_events SET position=${to},attempts=${attempts},next_attempt=${next},last_error=${error} WHERE id=${id} AND position=${from}`,
			);

		/** Live row at this cursor, or none if it was deleted, expired, or moved. */
		const live = (ctx: Store, id: string, from: number, now: number) =>
			ctx
				.read(() =>
					ctx.db`SELECT * FROM example_mcp_events WHERE id=${id} AND position=${from} AND refresh_before>${now}`.pipe(
						Effect.flatMap(decodeRows),
					),
				)
				.pipe(Effect.map((found) => found[0]));

		/** Delivers one subscription's pending mentions in order; says when to look again and whether more remain. */
		const drain = (ctx: BackgroundContext, row: typeof Row.Type, now: number) =>
			Effect.gen(function* () {
				if (row.next_attempt > now) return { wake: row.next_attempt, backlog: false };
				if (!(yield* granted(ctx, row.client_id, now))) {
					yield* ctx.mutate(ctx.db`DELETE FROM example_mcp_events WHERE id=${row.id}`);
					return { wake: Infinity, backlog: false };
				}
				const page = yield* ctx.messages.query({
					since: row.position,
					mentions: [`@${row.agent}`, "@here"],
					exclude: row.instance,
					limit: 16,
				});
				let position = row.position;
				let attempts = row.attempts;
				for (const message of page.items) {
					const at = yield* Clock.currentTimeMillis;
					const current = yield* live(ctx, row.id, position, at);
					// Stop if unsubscribe, expiry, grant loss, agent change, or another drain moved the cursor.
					if (!current || !(yield* granted(ctx, current.client_id, at)) || current.agent !== row.agent)
						return { wake: Infinity, backlog: false };
					const outcome = message.deleted_at === null ? yield* deliver(current, message) : "rejected";
					// Suppressed means this generation is no longer live; its scope is about to close.
					if (outcome === "suppressed") return { wake: now + 1000, backlog: false };
					attempts = outcome === "delivered" || outcome === "rejected" ? 0 : attempts + 1;
					if (attempts > 0 && attempts < maxAttempts) {
						const failedAt = yield* Clock.currentTimeMillis;
						const next = failedAt + Math.min(300_000, 10_000 * 2 ** (attempts - 1));
						yield* checkpoint(ctx, row.id, position, position, attempts, next, outcome);
						return { wake: next, backlog: false };
					}
					// Delivered, refused with 410 or 413, or out of attempts: move past this message.
					const error = attempts === 0 ? null : outcome;
					attempts = 0;
					yield* checkpoint(ctx, row.id, position, message.seq, 0, 0, error);
					position = message.seq;
				}
				if (page.cursor > position) yield* checkpoint(ctx, row.id, position, page.cursor, 0, 0, null);
				return { wake: now + 60_000, backlog: page.items.length === 16 };
			});

		/** Mentions are read through the public message query, so delivery sees exactly what the board has published. */
		const run = (ctx: BackgroundContext) =>
			Effect.gen(function* () {
				while (true) {
					const cycle = yield* Effect.gen(function* () {
						const fence = yield* ctx.read((value) => Effect.succeed(value));
						const now = yield* Clock.currentTimeMillis;
						yield* ctx.mutate(ctx.db`DELETE FROM example_mcp_events WHERE refresh_before<=${now}`);
						// Subscriptions drain concurrently so one slow callback cannot hold up the others.
						const results = yield* Effect.forEach(yield* rows(ctx), (row) => drain(ctx, row, now), {
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
