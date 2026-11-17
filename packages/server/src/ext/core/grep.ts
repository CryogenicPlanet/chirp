import { BunChildProcessSpawner } from "@effect/platform-bun";
import { isDescendant, nullable } from "@comms/storage/dialect";
import { Effect, Option, Path, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { ExtensionCapabilities } from "../../kernel/extension-capabilities.ts";
import { compile, GrepHit, GrepJob, GrepRow, GrepScan } from "./grep-scan.ts";
import { validTopic } from "./messages.ts";
import { publishedMessages } from "./published-messages.ts";

export class GrepRefused extends Schema.TaggedError<GrepRefused>()("GrepRefused", {
	code: Schema.Literals(["query_invalid", "pattern_invalid", "grep_timeout"]),
	message: Schema.String,
}) {}

export interface GrepInput {
	readonly pattern: string;
	readonly fixed?: boolean;
	/** Omitted means smart case: insensitive unless the pattern has an uppercase letter. */
	readonly ignoreCase?: boolean;
	readonly topic?: string;
	readonly agent?: string;
	readonly before?: number;
	readonly context?: number;
	readonly maxLines?: number;
	readonly limit?: number;
}
export const GrepResult = Schema.Struct({
	matches: Schema.Array(GrepHit),
	/** Matching messages among the scanned ones; `matches` holds the newest `limit` of them. */
	matched: Schema.Int,
	scanned: Schema.Int,
	has_more: Schema.Boolean,
	next_before: Schema.optionalKey(Schema.Int),
	warning: Schema.optionalKey(Schema.String),
});
type GrepContext = Pick<ExtensionCapabilities, "read"> & { readonly db: SqlClient };

/** One call scans at most this window, newest first; `next_before` continues below it. */
const windowRows = 5000;
/** Characters of body text (UTF-16 units), so the copy sent to a scan stays near 16 MiB. */
const windowChars = 8 * 1024 * 1024;
const pageRows = 500;
/** A scan process is killed past this; the whole call, waiting for a slot included, gets the longer budget. */
const scanBudget = "3 seconds";
const callBudget = "6 seconds";
const outputBytes = 16 * 1024 * 1024;
const timedOut = "The search ran too long. Simplify nested or repeated wildcards, or narrow topic or agent.";

const rows = Schema.decodeUnknownEffect(Schema.Array(GrepRow));
const encodeJob = Schema.encodeEffect(Schema.fromJsonString(GrepJob));
const decodeScan = Schema.decodeUnknownEffect(Schema.fromJsonString(GrepScan));
const refuse = (code: GrepRefused["code"], message: string) => Effect.fail(new GrepRefused({ code, message }));
const within = (value: number | undefined, fallback: number, low: number, high: number) =>
	value === undefined ? fallback : Number.isSafeInteger(value) && value >= low && value <= high ? value : null;

/** ripgrep's smart case: escapes, property classes and group names are syntax, not letters the user typed. */
export const smartCase = (pattern: string, fixed: boolean) =>
	!/\p{Lu}/u.test(fixed ? pattern : pattern.replace(/\\[pPk]\{[^}]*\}|\\k<[^>]*>|\(\?<[A-Za-z_]\w*>|\\./gu, ""));

/** Newest-first pages, each its own short snapshot, until the window is full or history ends. */
const collect = (ctx: GrepContext, input: GrepInput, before: number) =>
	Effect.gen(function* () {
		const sql = ctx.db;
		const topic = input.topic ?? null;
		const agent = input.agent ?? null;
		const window: Array<typeof GrepRow.Type> = [];
		let cursor = before,
			chars = 0,
			ended = false;
		while (!ended && window.length < windowRows && chars < windowChars) {
			const page = yield* rows(
				yield* ctx.read(
					(fence) => sql`WITH visible_messages AS (${publishedMessages(sql, fence)})
				 SELECT seq,topic,agent,created_at,body FROM visible_messages
				 WHERE deleted_at IS NULL AND seq<${cursor}
				 AND (${nullable(sql, topic)} IS NULL OR topic=${topic} OR ${isDescendant(sql, sql("topic"), topic ?? "")})
				 AND (${nullable(sql, agent)} IS NULL OR agent=${agent})
				 ORDER BY seq DESC LIMIT ${pageRows}`,
				),
			);
			// Stop at the cap inside a page too; the rest of the page is left for next_before.
			const kept: Array<typeof GrepRow.Type> = [];
			for (const row of page) {
				if (kept.length > 0 && (chars >= windowChars || window.length + kept.length >= windowRows)) break;
				kept.push(row);
				chars += row.body.length;
			}
			window.push(...kept);
			cursor = kept.at(-1)?.seq ?? cursor;
			ended = kept.length === page.length && page.length < pageRows;
		}
		return { window, complete: ended };
	});

/**
 * A grep runner for one extension: at most two scans at once, each in its own process. JavaScriptCore's compiled
 * regexes ignore Worker termination, so only SIGKILL stops a pattern that backtracks without end.
 */
export const makeGrep = Effect.gen(function* () {
	const slots = yield* Semaphore.make(2);
	// Extensions are not handed a spawner, but they get FileSystem and Path, which Bun's spawner layer needs.
	const spawner = yield* Effect.provide(ChildProcessSpawner.ChildProcessSpawner, BunChildProcessSpawner.layer);
	const path = yield* Path.Path;
	const entry = yield* path.fromFileUrl(new URL("./grep-worker.ts", import.meta.url));
	const scan = (job: typeof GrepJob.Type) =>
		Effect.scoped(
			Effect.gen(function* () {
				const child = yield* spawner.spawn(
					ChildProcess.make(process.execPath, [entry], {
						detached: false,
						stdin: Stream.make(new TextEncoder().encode(yield* encodeJob(job))),
						stdout: "pipe",
						stderr: "ignore",
						killSignal: "SIGKILL",
					}),
				);
				// Reap before responding: a timeout interrupts this scope, and the kill is what stops the scan.
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						if (yield* child.isRunning) yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.exit);
						yield* child.exitCode.pipe(Effect.exit);
					}).pipe(Effect.orDie),
				);
				// The deadline sits inside this scope so the kill and reap finish before the refusal is returned.
				const output = yield* child.stdout.pipe(
					Stream.decodeText(),
					Stream.runFoldEffect(
						() => "",
						(text, chunk) =>
							text.length + chunk.length > outputBytes
								? Effect.die("grep worker output exceeded limit")
								: Effect.succeed(text + chunk),
					),
					Effect.timeoutOption(scanBudget),
				);
				if (Option.isNone(output)) return yield* refuse("grep_timeout", timedOut);
				if ((yield* child.exitCode) !== 0) return yield* Effect.die("grep worker failed");
				return yield* decodeScan(output.value);
			}),
		);

	/** Regex search over published bodies, line by line and newest first, like ripgrep over files. */
	return (ctx: GrepContext, input: GrepInput) =>
		Effect.gen(function* () {
			const context = within(input.context, 0, 0, 5);
			const maxLines = within(input.maxLines, 5, 1, 20);
			const limit = within(input.limit, 20, 1, 100);
			const before = within(input.before, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
			if (
				input.pattern.length === 0 ||
				input.pattern.length > 500 ||
				input.pattern.includes("\0") ||
				context === null ||
				maxLines === null ||
				limit === null ||
				before === null ||
				(input.topic !== undefined && !validTopic(input.topic)) ||
				(input.agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.agent))
			)
				return yield* refuse(
					"query_invalid",
					"pattern is 1–500 characters; context 0–5, max_lines 1–20, limit 1–100; topic and agent must be valid names.",
				);
			const fixed = input.fixed ?? false;
			const ignoreCase = input.ignoreCase ?? smartCase(input.pattern, fixed);
			// Compiling runs no match, so it is safe here and refuses a bad pattern before any rows are read.
			const compiled = compile(input.pattern, fixed, ignoreCase);
			if (typeof compiled === "string") return yield* refuse("pattern_invalid", compiled);
			return yield* slots
				.withPermit(
					Effect.gen(function* () {
						const { window, complete } = yield* collect(ctx, input, before);
						const result = yield* scan({
							rows: window,
							options: {
								pattern: input.pattern,
								fixed,
								ignoreCase,
								context,
								maxLines,
								limit,
							},
						});
						if (!result.ok) return yield* refuse("pattern_invalid", result.error);
						// Older matches remain past the returned page, or past the scanned window.
						const resume =
							result.total > result.hits.length ? result.hits.at(-1) : complete ? undefined : window.at(-1);
						return {
							matches: result.hits,
							matched: result.total,
							scanned: window.length,
							has_more: resume !== undefined,
							...(resume === undefined ? {} : { next_before: resume.seq }),
							...(result.slow
								? {
										warning:
											"The pattern backtracked heavily. JavaScriptCore gives up on such a line and reports it as not matching, so matches may be missing. Simplify nested or repeated wildcards.",
									}
								: {}),
						} satisfies typeof GrepResult.Type;
					}),
				)
				.pipe(Effect.timeoutOrElse({ duration: callBudget, orElse: () => refuse("grep_timeout", timedOut) }));
		});
});
export type Grep = Effect.Success<typeof makeGrep>;
