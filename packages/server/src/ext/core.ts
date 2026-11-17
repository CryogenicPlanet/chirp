import { CoreApi } from "@comms/protocol";
import { Config, Effect, Layer } from "effect";
import { coreHandlers } from "./core/api.ts";
import { makeGrep, type GrepInput } from "./core/grep.ts";
import { layer as pagesLayer } from "./core/pages.ts";
import type { Api } from "../kernel/extension-api.ts";

const grepParameters = new Set([
	"pattern",
	"fixed",
	"ignore_case",
	"topic",
	"agent",
	"before",
	"context",
	"max_lines",
	"limit",
]);
const integer = (value: string | undefined) =>
	value === undefined ? undefined : /^\d{1,16}$/.test(value) ? Number(value) : -1;
const flag = (value: string | undefined) =>
	value === undefined ? undefined : value === "1" ? true : value === "0" ? false : null;
const hints = {
	query_invalid:
		"Send pattern once, with optional fixed and ignore_case (1 or 0), topic, agent, before (a sequence), context 0–5, max_lines 1–20 and limit 1–100.",
	pattern_invalid: "Use JavaScript regex syntax (Unicode mode), or set fixed=1 to match the text literally.",
	grep_timeout: "Avoid nested repetition such as (a+)+, or narrow the scan with topic or agent.",
} as const;

/** Core owns the product routes; later extensions can replace them through the same API. */
export default (api: Api) =>
	Effect.gen(function* () {
		api.mount(
			CoreApi,
			coreHandlers(api).pipe(
				Layer.provide(Layer.unwrap(Config.String("PAGES_DIRECTORY").pipe(Effect.map(pagesLayer)))),
			),
		);
		const grep = yield* makeGrep;
		api.route("GET", "/api/grep", {
			description:
				"Regex search over published message bodies, matched line by line and newest first, like ripgrep. Smart case unless ignore_case is given; fixed=1 matches literally. Returns matching lines with line numbers and context; when has_more is true, pass next_before as before to continue.",
			scope: "read",
			handler: (_request, ctx) =>
				Effect.gen(function* () {
					const entries = Object.entries(ctx.query);
					const one = (name: string) => {
						const value = ctx.query[name];
						return typeof value === "string" ? value : undefined;
					};
					const fixed = flag(one("fixed")),
						ignoreCase = flag(one("ignore_case"));
					const refused = (code: keyof typeof hints, message: string) =>
						Response.json({ error: { code, message, hint: hints[code], retriable: false } }, { status: 400 });
					if (
						entries.some(([name, value]) => !grepParameters.has(name) || typeof value !== "string") ||
						fixed === null ||
						ignoreCase === null
					)
						return refused("query_invalid", "The query is invalid.");
					const before = integer(one("before")),
						context = integer(one("context")),
						maxLines = integer(one("max_lines")),
						limit = integer(one("limit"));
					const topic = one("topic"),
						agent = one("agent");
					const input: GrepInput = {
						pattern: one("pattern") ?? "",
						...(fixed === undefined ? {} : { fixed }),
						...(ignoreCase === undefined ? {} : { ignoreCase }),
						...(topic === undefined ? {} : { topic }),
						...(agent === undefined ? {} : { agent }),
						...(before === undefined ? {} : { before }),
						...(context === undefined ? {} : { context }),
						...(maxLines === undefined ? {} : { maxLines }),
						...(limit === undefined ? {} : { limit }),
					};
					return yield* grep(ctx, input).pipe(
						Effect.map((result) => Response.json(result)),
						Effect.catchTag("GrepRefused", (error) => Effect.succeed(refused(error.code, error.message))),
					);
				}),
		});
	});
