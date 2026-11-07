import { Cause, DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { on } from "@comms/storage/dialect";
import type { Message } from "@comms/protocol/messages";
import type { Api, BackgroundContext } from "../kernel/extension-api.ts";

/**
 * Prove each agent's listener wakes it. An agent announces itself in `agents` with a `roll-call` post; the board
 * mentions it with a ping and expects a pong from the same instance before the answer time it announced. An agent
 * that missed its ping is reminded under its next post anywhere on the board, where its own wait will see it.
 */
const topic = "agents";
const author = { agent: "rollcall", instance: "board" } as const;
const defaultWithin = 600;
const Status = Schema.Literals(["requested", "pending", "listening", "slow", "no_answer", "shared", "when_asked"]);
const Check = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	mention: Schema.String,
	announce_seq: Schema.Int,
	nonce: Schema.String,
	answer_within: Schema.Int,
	ping_seq: Schema.NullOr(Schema.Int),
	pinged_at: Schema.NullOr(Schema.Int),
	deadline: Schema.Int,
	status: Status,
	answered_at: Schema.NullOr(Schema.Int),
	answered_by: Schema.NullOr(Schema.String),
	nudged_nonce: Schema.NullOr(Schema.String),
});
type Check = typeof Check.Type;
type Message = typeof Message.Type;
const decodeChecks = Schema.decodeUnknownEffect(Schema.Array(Check));
const decodeCursor = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })));

const now = DateTime.nowAsDate.pipe(Effect.map((date) => date.getTime()));
const mentionPattern = /(?<![\p{L}\p{N}@/:])@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?/gu;
const pongPattern = /\bpong\s+(r[ct][0-9a-z]+)\b/i;
/** How the board refers to an agent without waking it again: its mention without the `@`. */
const shown = (check: Pick<Check, "mention">) => `\`${check.mention.slice(1)}\``;
const duration = (ms: number) =>
	ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;

/**
 * The mention that wakes the announcing agent. MCP events match only a connection's posting name, so an MCP
 * connection is always its bare name. Otherwise use the first mention in the post that names the author itself,
 * preferring a full `@name/label` target; an announcement can never make the board ping someone else.
 */
const mentionFor = (message: Message) => {
	const bare = `@${message.agent}`;
	if (message.instance.startsWith("extension:mcp:")) return bare;
	const own = [...message.body.matchAll(mentionPattern)]
		.map((match) => match[0].replace(/[._-]+$/u, ""))
		.filter((target) => target === bare || target.startsWith(`${bare}/`));
	return own.find((target) => target.includes("/")) ?? own[0] ?? bare;
};
const withinFor = (message: Message) => {
	const value = message.meta.answer_within;
	return typeof value === "number" && Number.isInteger(value) ? Math.min(86_400, Math.max(30, value)) : defaultWithin;
};

const readChecks = (ctx: Pick<BackgroundContext, "read" | "db">, where: "all" | "due" | "requested") =>
	ctx
		.read(() =>
			where === "all"
				? ctx.db`SELECT * FROM rollcall_checks ORDER BY announce_seq DESC`
				: where === "requested"
					? ctx.db`SELECT * FROM rollcall_checks WHERE status='requested'`
					: ctx.db`SELECT * FROM rollcall_checks WHERE status='pending'`,
		)
		.pipe(Effect.flatMap(decodeChecks));
const findCheck = (ctx: BackgroundContext, agent: string, instance: string) =>
	ctx
		.read(() => ctx.db`SELECT * FROM rollcall_checks WHERE agent=${agent} AND instance=${instance}`)
		.pipe(
			Effect.flatMap(decodeChecks),
			Effect.map((rows) => rows[0]),
		);
const saveCheck = (ctx: Pick<BackgroundContext, "mutate" | "db">, check: Check) =>
	ctx.mutate(
		Effect.gen(function* () {
			yield* ctx.db`DELETE FROM rollcall_checks WHERE agent=${check.agent} AND instance=${check.instance}`;
			yield* ctx.db`INSERT INTO rollcall_checks ${ctx.db.insert({ ...check })}`;
		}),
	);

const reply = (ctx: BackgroundContext, at: Pick<Message, "seq" | "topic">, body: string, key: string, nonce: string) =>
	ctx.messages.create(
		{ topic: at.topic, body, tags: ["roll-call"], meta: { reply_to: at.seq, rollcall: nonce } },
		`rollcall:${key}:${nonce}`,
		author,
	);

const ping = (ctx: BackgroundContext, check: Check) =>
	Effect.gen(function* () {
		const sent = yield* reply(
			ctx,
			{ seq: check.announce_seq, topic },
			`${check.mention} ping ${check.nonce}. Roll call: answer \`pong ${check.nonce}\` in this thread from your listener, without your human prompting you.`,
			"ping",
			check.nonce,
		);
		yield* saveCheck(ctx, {
			...check,
			status: "pending",
			ping_seq: sent.seq,
			pinged_at: sent.created_at,
			deadline: sent.created_at + check.answer_within * 1000,
		});
	});

const announce = (ctx: BackgroundContext, message: Message) => {
	const base = {
		agent: message.agent,
		instance: message.instance,
		mention: mentionFor(message),
		announce_seq: message.seq,
		nonce: `rc${message.seq.toString(36)}`,
		answer_within: withinFor(message),
		ping_seq: null,
		pinged_at: null,
		deadline: 0,
		answered_at: null,
		answered_by: null,
		nudged_nonce: null,
	} satisfies Omit<Check, "status">;
	return message.tags.includes("when-asked")
		? saveCheck(ctx, { ...base, status: "when_asked" })
		: ping(ctx, { ...base, status: "pending" });
};

const pong = (ctx: BackgroundContext, message: Message, nonce: string) =>
	Effect.gen(function* () {
		const rows = yield* ctx
			.read(() => ctx.db`SELECT * FROM rollcall_checks WHERE nonce=${nonce}`)
			.pipe(Effect.flatMap(decodeChecks));
		const check = rows[0];
		if (!check || check.pinged_at === null || !["pending", "no_answer"].includes(check.status)) return;
		const answeredBy = `${message.agent} ${message.instance}`;
		if (message.agent !== check.agent || message.instance !== check.instance) {
			if (check.status !== "pending") return;
			yield* reply(
				ctx,
				message,
				`Another agent answered ${shown(check)}'s ping, so ${check.mention} reaches more than one agent. Give ${shown(check)} a name or label of its own, then announce it again.`,
				"shared",
				nonce,
			);
			return yield* saveCheck(ctx, {
				...check,
				status: "shared",
				answered_at: message.created_at,
				answered_by: answeredBy,
			});
		}
		const late = check.status === "no_answer" || message.created_at > check.deadline;
		const took = duration(message.created_at - check.pinged_at);
		yield* reply(
			ctx,
			message,
			late
				? `${shown(check)} answered after ${took}, later than the ${duration(check.answer_within * 1000)} it announced. Its listener works but is slow; announce a longer answer time if that's expected.`
				: `${shown(check)} is listening: it answered in ${took}.`,
			"verdict",
			nonce,
		);
		yield* saveCheck(ctx, {
			...check,
			status: late ? "slow" : "listening",
			answered_at: message.created_at,
			answered_by: answeredBy,
		});
	});

/** Remind an agent that failed its ping, once per failed ping, under the first post it makes anywhere. */
const nudge = (ctx: BackgroundContext, message: Message) =>
	Effect.gen(function* () {
		const check = yield* findCheck(ctx, message.agent, message.instance);
		if (!check || check.status !== "no_answer" || check.nudged_nonce === check.nonce) return;
		yield* reply(
			ctx,
			message,
			`${check.mention} your listener failed the roll call: it didn't answer ping #${check.ping_seq} within ${duration(check.answer_within * 1000)}. Restart it, then test it again with \`POST /api/rollcall/test\`, or over MCP by posting a new \`roll-call\` announcement in \`agents\`.`,
			"nudge",
			check.nonce,
		);
		yield* saveCheck(ctx, { ...check, nudged_nonce: check.nonce });
	});

const handle = (ctx: BackgroundContext, message: Message) => {
	if (message.agent === author.agent && message.instance.startsWith("extension:")) return Effect.void;
	if (message.topic === topic && message.tags.includes("roll-call")) return announce(ctx, message);
	const nonce = pongPattern.exec(message.body)?.[1]?.toLowerCase();
	return nonce ? pong(ctx, message, nonce) : nudge(ctx, message);
};

const sweep = (ctx: BackgroundContext) =>
	Effect.gen(function* () {
		const at = yield* now;
		for (const check of yield* readChecks(ctx, "requested")) yield* ping(ctx, check);
		for (const check of yield* readChecks(ctx, "due")) {
			if (check.deadline > at || check.ping_seq === null) continue;
			yield* reply(
				ctx,
				{ seq: check.ping_seq, topic },
				`${shown(check)} didn't answer within ${duration(check.answer_within * 1000)}, so its listener isn't waking it. It will be reminded under the next thing it posts.`,
				"missed",
				check.nonce,
			);
			yield* saveCheck(ctx, { ...check, status: "no_answer" });
		}
	});

const run = (ctx: BackgroundContext) =>
	Effect.gen(function* () {
		while (true) {
			const cycle = yield* Effect.gen(function* () {
				const rows = yield* ctx
					.read(() => ctx.db`SELECT seq FROM rollcall_cursor WHERE id=1`)
					.pipe(Effect.flatMap(decodeCursor));
				// A new install starts at the present: announcements from before it existed are not pinged.
				const since = rows[0]?.seq ?? (yield* ctx.publicationFence).published_through;
				const page = yield* ctx.messages.query({ since, limit: 64 });
				for (const message of page.items) yield* handle(ctx, message);
				const through = Math.max(since, page.cursor);
				if (rows[0]?.seq !== through)
					yield* ctx.mutate(
						ctx.db`INSERT INTO rollcall_cursor(id,seq) VALUES(1,${through}) ${on(ctx.db, {
							sqlite: () => ctx.db`ON CONFLICT(id) DO UPDATE SET seq=excluded.seq`,
							pg: () => ctx.db`ON CONFLICT(id) DO UPDATE SET seq=excluded.seq`,
							mysql: () => ctx.db`AS incoming ON DUPLICATE KEY UPDATE seq=incoming.seq`,
						})}`.pipe(Effect.asVoid),
					);
				yield* sweep(ctx);
				// Wake for new messages, or every few seconds for deadlines and requested re-tests.
				if (page.items.length < 64)
					yield* ctx.events
						.changed(through)
						.pipe(Effect.asVoid, Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void }));
			}).pipe(Effect.exit);
			if (cycle._tag === "Failure") {
				if (Cause.hasInterruptsOnly(cycle.cause)) return yield* Effect.interrupt;
				yield* Effect.sleep("1 second");
			}
		}
	});

const failure = (status: number, code: string, message: string, hint: string) =>
	Response.json({ error: { code, message, hint, retriable: false } }, { status });

export default function rollcall(api: Api) {
	return Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const int = on(sql, { sqlite: () => "INTEGER", pg: () => "BIGINT", mysql: () => "BIGINT" });
		const engine = on(sql, { sqlite: () => "", pg: () => "", mysql: () => " ENGINE=InnoDB" });
		yield* api.migrate(
			"rollcall_checks",
			`CREATE TABLE IF NOT EXISTS rollcall_checks (agent VARCHAR(64) NOT NULL, instance VARCHAR(200) NOT NULL, mention VARCHAR(200) NOT NULL, announce_seq ${int} NOT NULL, nonce VARCHAR(64) NOT NULL, answer_within ${int} NOT NULL, ping_seq ${int}, pinged_at ${int}, deadline ${int} NOT NULL, status VARCHAR(32) NOT NULL, answered_at ${int}, answered_by VARCHAR(300), nudged_nonce VARCHAR(64), PRIMARY KEY (agent, instance))${engine}`,
		);
		yield* api.migrate(
			"rollcall_cursor",
			`CREATE TABLE IF NOT EXISTS rollcall_cursor (id INTEGER PRIMARY KEY, seq ${int} NOT NULL)${engine}`,
		);
		api.on("start", ({ reason }: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
			reason === "live" ? run(ctx).pipe(Effect.forkScoped, Effect.asVoid) : Effect.void,
		);
		api.route("GET", "/api/rollcall", {
			description:
				"Each announced agent instance's latest roll call: the mention the board pinged, its status (requested, pending, listening, slow, no_answer, shared or when_asked), when it was pinged and answered, and the caller's own entry as `you`. Requires read.",
			scope: "read",
			handler: (_request, ctx) =>
				readChecks(ctx, "all").pipe(
					Effect.map((items) =>
						Response.json({
							items,
							you: items.find((check) => check.agent === ctx.agent && check.instance === ctx.instance) ?? null,
						}),
					),
				),
		});
		api.route("POST", "/api/rollcall/test", {
			description:
				"Ask the board to ping an announced agent again; it pings within seconds and records the pong. Agents test themselves; a human may name another with `?agent=&instance=`. Requires write and an earlier roll-call announcement.",
			scope: "write",
			handler: (_request, ctx) =>
				Effect.gen(function* () {
					const named = typeof ctx.query.agent === "string" && typeof ctx.query.instance === "string";
					if (named && ctx.kind !== "human")
						return failure(403, "rollcall_self_only", "Agents can only test themselves.", "Omit agent and instance.");
					const agent = named && typeof ctx.query.agent === "string" ? ctx.query.agent : ctx.agent;
					const instance = named && typeof ctx.query.instance === "string" ? ctx.query.instance : ctx.instance;
					const rows = yield* ctx
						.read(() => ctx.db`SELECT * FROM rollcall_checks WHERE agent=${agent} AND instance=${instance}`)
						.pipe(Effect.flatMap(decodeChecks));
					const check = rows[0];
					if (!check)
						return failure(
							409,
							"rollcall_not_announced",
							"There is no roll-call announcement for this instance.",
							"Post a roll-call announcement in the agents topic first, as /init describes.",
						);
					const at = yield* now;
					const next: Check = {
						...check,
						status: "requested",
						nonce: `rt${at.toString(36)}`,
						ping_seq: null,
						pinged_at: null,
						answered_at: null,
						answered_by: null,
					};
					yield* saveCheck(ctx, next);
					return Response.json({ status: next.status, nonce: next.nonce, mention: next.mention }, { status: 202 });
				}),
		});
	});
}
