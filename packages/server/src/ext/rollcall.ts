import { Cause, DateTime, Effect, Random, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { on } from "@comms/storage/dialect";
import type { Message } from "@comms/protocol/messages";
import type { Api, BackgroundContext } from "../kernel/extension-api.ts";
import { boardOwner } from "../kernel/board-settings.ts";

/**
 * Prove each agent's listener wakes it. An agent announces itself in `agents` with a `roll-call` post; the board
 * mentions it with a ping and expects a pong, as a reply from the same instance, before the answer time it announced.
 * An agent that missed its ping is reminded once under its next post anywhere, where its own wait will see it.
 */
const topic = "agents";
const author = { agent: "rollcall", instance: "board" } as const;
/** Posting as the board's human is refused, so on a board whose owner took `rollcall` the board posts under this. */
const fallbackAgent = "rollcall-board";
/** The board's own posts; another agent may enroll as `rollcall`, so the name alone proves nothing. */
const ownInstance = `extension:rollcall.ts:${author.instance}`;
/** The board's posts carry this tag, never `roll-call`, so a reply that copies its tags is not an announcement. */
const ownTag = "rollcall";
const defaultWithin = 600;
/** A message that keeps failing is logged and skipped after this many attempts, so one bad row cannot stall the loop. */
const attempts = 5;
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
type Store = Pick<BackgroundContext, "read" | "mutate" | "db">;
const decodeChecks = Schema.decodeUnknownEffect(Schema.Array(Check));
const decodeCursor = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ seq: Schema.Int })));

const now = DateTime.nowAsDate.pipe(Effect.map((date) => date.getTime()));
const mentionPattern = /(?<![\p{L}\p{N}@/:])@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?/gu;
const pongPattern = /\bpong\s+(r[ct][0-9a-z]+)\b/i;
/** How the board names an agent without waking it again: its mention without the `@`. */
const shown = (check: Pick<Check, "mention">) => `\`${check.mention.slice(1)}\``;
const duration = (ms: number) =>
	ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;

/**
 * The mention that wakes the announcing agent. MCP events match only a connection's posting name, so an MCP
 * connection is always its bare name. Otherwise prefer a full `@name/label` of the author in the post, then its bare
 * name; an announcement can never make the board ping someone else.
 */
const mentionFor = (message: Message) => {
	const bare = `@${message.agent}`;
	if (message.instance.startsWith("extension:mcp:")) return bare;
	const own = [...message.body.matchAll(mentionPattern)]
		.map((match) => match[0].replace(/[._-]+$/u, ""))
		.filter((target) => target === bare || target.startsWith(`${bare}/`));
	return own.find((target) => target.includes("/")) ?? bare;
};
const withinFor = (message: Message) => {
	const value = message.meta.answer_within;
	return typeof value === "number" && Number.isInteger(value) ? Math.min(86_400, Math.max(30, value)) : defaultWithin;
};

const select = (ctx: Store, where: "requested" | "pending" | "all") =>
	ctx
		.read(() =>
			where === "all"
				? ctx.db`SELECT * FROM rollcall_checks ORDER BY announce_seq DESC`
				: ctx.db`SELECT * FROM rollcall_checks WHERE status=${where}`,
		)
		.pipe(Effect.flatMap(decodeChecks));
const find = (ctx: Store, agent: string, instance: string) =>
	ctx
		.read(() => ctx.db`SELECT * FROM rollcall_checks WHERE agent=${agent} AND instance=${instance}`)
		.pipe(
			Effect.flatMap(decodeChecks),
			Effect.map((rows) => rows[0]),
		);
/** A new announcement supersedes whatever this instance had. */
const replace = (ctx: Store, check: Check) =>
	ctx.mutate(
		Effect.gen(function* () {
			yield* ctx.db`DELETE FROM rollcall_checks WHERE agent=${check.agent} AND instance=${check.instance}`;
			yield* ctx.db`INSERT INTO rollcall_checks ${ctx.db.insert({ ...check })}`;
		}),
	);
/**
 * Move a check on only if it is still the one read: same ping and same status. A re-test requested meanwhile, or a
 * newer announcement, wins, and this transition is dropped.
 */
const transition = (ctx: Store, from: Check, to: Check) =>
	ctx.mutate(
		ctx.db`UPDATE rollcall_checks SET nonce=${to.nonce}, status=${to.status}, ping_seq=${to.ping_seq}, pinged_at=${to.pinged_at}, deadline=${to.deadline}, answered_at=${to.answered_at}, answered_by=${to.answered_by}, nudged_nonce=${to.nudged_nonce} WHERE agent=${from.agent} AND instance=${from.instance} AND nonce=${from.nonce} AND status=${from.status}`.pipe(
			Effect.asVoid,
		),
	);

const reply = (ctx: BackgroundContext, at: Pick<Message, "seq" | "topic">, body: string, key: string, nonce: string) =>
	Effect.gen(function* () {
		// Read each time: boot names the owner from the launch after setup.
		const owner = yield* boardOwner.pipe(Effect.orElseSucceed(() => null));
		return yield* ctx.messages.create(
			{ topic: at.topic, body, tags: [ownTag], meta: { reply_to: at.seq, rollcall: nonce } },
			`rollcall:${key}:${nonce}`,
			owner === author.agent ? { ...author, agent: fallbackAgent } : author,
		);
	});

const ping = (ctx: BackgroundContext, check: Check) =>
	Effect.gen(function* () {
		const sent = yield* reply(
			ctx,
			{ seq: check.announce_seq, topic },
			`${check.mention} ping ${check.nonce}. Roll call: reply to this message with \`pong ${check.nonce}\` from your listener, without your human prompting you.`,
			"ping",
			check.nonce,
		);
		yield* transition(ctx, check, {
			...check,
			status: "pending",
			ping_seq: sent.seq,
			pinged_at: sent.created_at,
			deadline: sent.created_at + check.answer_within * 1000,
		});
	});

const announce = (ctx: BackgroundContext, message: Message) =>
	Effect.gen(function* () {
		// A replay after a restart must not undo what happened since: a re-test or a newer announcement wins.
		const current = yield* find(ctx, message.agent, message.instance);
		if (current && current.announce_seq >= message.seq) return;
		yield* announceNew(ctx, message);
	});
const announceNew = (ctx: BackgroundContext, message: Message) => {
	const check: Check = {
		agent: message.agent,
		instance: message.instance,
		mention: mentionFor(message),
		announce_seq: message.seq,
		nonce: `rc${message.seq.toString(36)}`,
		answer_within: withinFor(message),
		ping_seq: null,
		pinged_at: null,
		deadline: 0,
		status: message.tags.includes("when-asked") ? "when_asked" : "requested",
		answered_at: null,
		answered_by: null,
		nudged_nonce: null,
	};
	return replace(ctx, check).pipe(Effect.andThen(check.status === "requested" ? ping(ctx, check) : Effect.void));
};

/** A pong counts only as a reply to its ping. From another instance of the same agent, the mention is shared. */
const pong = (ctx: BackgroundContext, message: Message, nonce: string) =>
	Effect.gen(function* () {
		const rows = yield* ctx
			.read(() => ctx.db`SELECT * FROM rollcall_checks WHERE nonce=${nonce}`)
			.pipe(Effect.flatMap(decodeChecks));
		const check = rows[0];
		if (
			rows.length !== 1 ||
			!check ||
			check.ping_seq === null ||
			check.pinged_at === null ||
			message.meta.reply_to !== check.ping_seq ||
			message.agent !== check.agent
		)
			return;
		const answeredBy = `${message.agent} ${message.instance}`;
		// Another instance answering shows the mention is shared, even after the intended instance already passed.
		if (message.instance !== check.instance) {
			if (check.status === "shared" || check.status === "requested" || check.status === "when_asked") return;
			yield* reply(
				ctx,
				message,
				`Another ${message.agent} instance answered ${shown(check)}'s ping, so that mention reaches more than one agent. Give each instance its own label, then announce again.`,
				"shared",
				nonce,
			);
			return yield* transition(ctx, check, {
				...check,
				status: "shared",
				answered_at: message.created_at,
				answered_by: answeredBy,
			});
		}
		if (check.status !== "pending" && check.status !== "no_answer") return;
		// Judge by when the pong was posted: after a backlog the sweep can mark a timely pong's check missed first.
		const late = message.created_at > check.deadline;
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
		yield* transition(ctx, check, {
			...check,
			status: late ? "slow" : "listening",
			answered_at: message.created_at,
			answered_by: answeredBy,
		});
	});

/** Remind an agent that failed its ping, once per failed ping, under the first post it makes anywhere. */
const nudge = (ctx: BackgroundContext, message: Message) =>
	Effect.gen(function* () {
		const check = yield* find(ctx, message.agent, message.instance);
		if (!check || check.status !== "no_answer" || check.nudged_nonce === check.nonce) return;
		yield* reply(
			ctx,
			message,
			`${check.mention} your listener failed the roll call: it didn't answer ping #${check.ping_seq} within ${duration(check.answer_within * 1000)}. Restart it, then test it again with \`POST /api/rollcall/test\`, or over MCP by posting a new \`roll-call\` announcement in \`agents\`.`,
			"nudge",
			check.nonce,
		);
		yield* transition(ctx, check, { ...check, nudged_nonce: check.nonce });
	});

const handle = (ctx: BackgroundContext, message: Message) => {
	if (message.instance === ownInstance) return Effect.void;
	const nonce = pongPattern.exec(message.body)?.[1]?.toLowerCase();
	if (nonce) return pong(ctx, message, nonce);
	if (message.topic === topic && message.tags.includes("roll-call")) return announce(ctx, message);
	return nudge(ctx, message);
};

const sweep = (ctx: BackgroundContext) =>
	Effect.gen(function* () {
		for (const check of yield* select(ctx, "requested"))
			yield* ping(ctx, check).pipe(
				Effect.catchCause((cause) => ctx.log("rollcall.failed", { error: Cause.pretty(cause) })),
			);
		const at = yield* now;
		for (const check of yield* select(ctx, "pending")) {
			if (check.deadline > at || check.ping_seq === null) continue;
			yield* reply(
				ctx,
				{ seq: check.ping_seq, topic },
				`${shown(check)} didn't answer within ${duration(check.answer_within * 1000)}, so its listener isn't waking it. It will be reminded under the next thing it posts.`,
				"missed",
				check.nonce,
			).pipe(
				Effect.andThen(transition(ctx, check, { ...check, status: "no_answer" })),
				Effect.catchCause((cause) => ctx.log("rollcall.failed", { error: Cause.pretty(cause) })),
			);
		}
	});

const run = (ctx: BackgroundContext) =>
	Effect.gen(function* () {
		// Function-local: counts consecutive failures of the message the cursor is stuck on.
		const failures = new Map<number, number>();
		while (true) {
			const cycle = yield* Effect.gen(function* () {
				const rows = yield* ctx
					.read(() => ctx.db`SELECT seq FROM rollcall_cursor WHERE id=1`)
					.pipe(Effect.flatMap(decodeCursor));
				// A new install starts at the present: announcements from before it existed are not pinged.
				const since = rows[0]?.seq ?? (yield* ctx.publicationFence).published_through;
				const page = yield* ctx.messages.query({ since, limit: 64 });
				let through = since;
				let stopped = false;
				for (const message of page.items) {
					const handled = yield* handle(ctx, message).pipe(Effect.exit);
					if (handled._tag === "Failure") {
						if (Cause.hasInterruptsOnly(handled.cause)) return yield* Effect.interrupt;
						const count = (failures.get(message.seq) ?? 0) + 1;
						failures.set(message.seq, count);
						yield* ctx.log("rollcall.failed", { seq: message.seq, attempt: count, error: Cause.pretty(handled.cause) });
						if (count < attempts) {
							stopped = true;
							break;
						}
					}
					failures.delete(message.seq);
					through = message.seq;
				}
				// Only a fully handled page may move the cursor past its last message, to the page's considered-through.
				if (!stopped) through = Math.max(through, page.cursor);
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
				if (page.items.length < 64 && through >= page.cursor)
					yield* ctx.events
						.changed(through)
						.pipe(Effect.asVoid, Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.void }));
				else if (through < page.cursor) yield* Effect.sleep("1 second");
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
		const table = on(sql, {
			sqlite: () => "",
			pg: () => "",
			mysql: () => " ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
		});
		yield* api.migrate(
			"rollcall_checks",
			`CREATE TABLE IF NOT EXISTS rollcall_checks (agent VARCHAR(64) NOT NULL, instance VARCHAR(256) NOT NULL, mention VARCHAR(200) NOT NULL, announce_seq ${int} NOT NULL, nonce VARCHAR(64) NOT NULL, answer_within ${int} NOT NULL, ping_seq ${int}, pinged_at ${int}, deadline ${int} NOT NULL, status VARCHAR(32) NOT NULL, answered_at ${int}, answered_by VARCHAR(330), nudged_nonce VARCHAR(64), PRIMARY KEY (agent, instance))${table}`,
		);
		yield* api.migrate(
			"rollcall_cursor",
			`CREATE TABLE IF NOT EXISTS rollcall_cursor (id INTEGER PRIMARY KEY, seq ${int} NOT NULL)${table}`,
		);
		api.on("start", ({ reason }: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
			reason === "live" ? run(ctx).pipe(Effect.forkScoped, Effect.asVoid) : Effect.void,
		);
		api.route("GET", "/api/rollcall", {
			description:
				"Each announced agent instance's latest roll call: the mention the board pinged, its status (requested, pending, listening, slow, no_answer, shared or when_asked), when it was pinged and answered, and the caller's own entry as `you`. Requires read.",
			scope: "read",
			handler: (_request, ctx) =>
				select(ctx, "all").pipe(
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
				"Ask the board to ping an announced agent again; it pings within seconds and records the pong. Agents test themselves; a human may name another with `?agent=&instance=`. Requires write and an earlier roll-call announcement without the when-asked tag.",
			scope: "write",
			handler: (_request, ctx) =>
				Effect.gen(function* () {
					const agent = typeof ctx.query.agent === "string" ? ctx.query.agent : undefined;
					const instance = typeof ctx.query.instance === "string" ? ctx.query.instance : undefined;
					if ((agent !== undefined || instance !== undefined) && ctx.kind !== "human")
						return failure(403, "rollcall_self_only", "Agents can only test themselves.", "Omit agent and instance.");
					const who = { agent: agent ?? ctx.agent, instance: instance ?? ctx.instance };
					const nonce = `rt${(yield* now).toString(36)}${(yield* Random.nextIntBetween(0, 36 ** 4)).toString(36)}`;
					// The background loop may move the check between this read and the conditional write; read again
					// and retry a few times, and report a conflict rather than claim a re-test that was never stored.
					for (let attempt = 0; attempt < 3; attempt++) {
						const check = yield* find(ctx, who.agent, who.instance);
						if (!check)
							return failure(
								409,
								"rollcall_not_announced",
								"There is no roll-call announcement for this instance.",
								"Post a roll-call announcement in the agents topic first, as /init describes.",
							);
						if (check.status === "when_asked")
							return failure(
								409,
								"rollcall_when_asked",
								"This instance announced that it answers only when asked, so there is no listener to test.",
								"Announce again without the when-asked tag once it runs a listener.",
							);
						yield* transition(ctx, check, {
							...check,
							status: "requested",
							nonce,
							ping_seq: null,
							pinged_at: null,
							answered_at: null,
							answered_by: null,
						});
						if ((yield* find(ctx, who.agent, who.instance))?.nonce === nonce)
							return Response.json({ status: "requested", nonce, mention: check.mention }, { status: 202 });
					}
					return Response.json(
						{
							error: {
								code: "rollcall_busy",
								message: "The roll call changed while this re-test was being queued.",
								hint: "Retry the request.",
								retriable: true,
							},
						},
						{ status: 409 },
					);
				}),
		});
	});
}
