import { Schema } from "effect";

/** One published message to scan, newest first. */
export const GrepRow = Schema.Struct({
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	created_at: Schema.Int,
	body: Schema.String,
});
export const GrepOptions = Schema.Struct({
	pattern: Schema.String,
	fixed: Schema.Boolean,
	ignoreCase: Schema.Boolean,
	context: Schema.Int,
	maxLines: Schema.Int,
	limit: Schema.Int,
});
export const GrepJob = Schema.Struct({ rows: Schema.Array(GrepRow), options: GrepOptions });
const GrepLine = Schema.Struct({ line: Schema.Int, text: Schema.String, match: Schema.Boolean });
export const GrepHit = Schema.Struct({
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	created_at: Schema.Int,
	matched_lines: Schema.Int,
	lines: Schema.Array(GrepLine),
});
/** What a scan returns: the first `limit` matching messages and how many matched in all. */
export const GrepScan = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true), hits: Schema.Array(GrepHit), total: Schema.Int, slow: Schema.Boolean }),
	Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/** Lines longer than this show a window around their first match. */
const lineWidth = 300;
/**
 * JavaScriptCore abandons a match after a fixed amount of backtracking (about 300 ms here) and answers false. An
 * ordinary line takes well under a millisecond, so anything near this means the engine may have given up.
 */
const slowLineMs = 50;

/** The pattern as a line matcher, or why it does not compile. Smart case is resolved by the caller. */
export const compile = (pattern: string, fixed: boolean, ignoreCase: boolean): RegExp | string => {
	const source = fixed ? pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") : pattern;
	try {
		return new RegExp(source, ignoreCase ? "iu" : "u");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

const low = (text: string, index: number) => /[\uDC00-\uDFFF]/.test(text.charAt(index));
const clip = (text: string, at: number) => {
	if (text.length <= lineWidth) return text;
	const from = Math.max(0, Math.min(at - 100, text.length - lineWidth));
	// Keep surrogate pairs whole at both edges.
	const start = low(text, from) ? from + 1 : from;
	const end = low(text, from + lineWidth) ? from + lineWidth + 1 : from + lineWidth;
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

/**
 * Match each line of each body, as ripgrep matches lines of files. A message shows its first `maxLines` matching
 * lines with `context` lines around each; `matched_lines` still counts every match.
 */
export const scan = (job: typeof GrepJob.Type): typeof GrepScan.Type => {
	const { rows, options } = job;
	const matcher = compile(options.pattern, options.fixed, options.ignoreCase);
	if (typeof matcher === "string") return { ok: false, error: matcher };
	const timed = (text: string) => {
		const started = performance.now();
		const found = matcher.test(text);
		return { found, slow: performance.now() - started > slowLineMs };
	};
	const scanned = rows.map((row) => {
		const lines = row.body.split(/\r?\n/);
		const tests = lines.map(timed);
		return { row, lines, tests };
	});
	const hits = scanned.flatMap(({ row, lines, tests }) => {
		const matched = tests.flatMap((test, index) => (test.found ? [index] : []));
		if (matched.length === 0) return [];
		const shown = new Set(
			matched
				.slice(0, options.maxLines)
				.flatMap((index) =>
					Array.from({ length: options.context * 2 + 1 }, (_, offset) => index - options.context + offset),
				)
				.filter((index) => index >= 0 && index < lines.length),
		);
		const matches = new Set(matched);
		return [
			{
				seq: row.seq,
				topic: row.topic,
				agent: row.agent,
				created_at: row.created_at,
				matched_lines: matched.length,
				lines: [...shown]
					.sort((a, b) => a - b)
					.map((index) => {
						const text = lines[index] ?? "";
						return { line: index + 1, text: clip(text, Math.max(0, text.search(matcher))), match: matches.has(index) };
					}),
			},
		];
	});
	return {
		ok: true,
		hits: hits.slice(0, options.limit),
		total: hits.length,
		slow: scanned.some(({ tests }) => tests.some((test) => test.slow)),
	};
};
