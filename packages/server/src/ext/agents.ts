import { DateTime, Effect, Schema } from "effect";
import type { Api } from "../kernel/extension-api.ts";

const day = 86_400_000;

interface Activity {
	readonly agent: string;
	readonly posts: number;
	readonly posts_24h: number;
	readonly posts_7d: number;
	readonly last_post_at: number;
	readonly mcp: boolean;
}

interface Reads {
	readonly instance: string;
	readonly read: number;
	readonly unread: number;
	readonly topics: number;
}

const Mark = Schema.Struct({ instance: Schema.String, topic: Schema.String, seq: Schema.Int });

/** A topic and every ancestor, root ("") first: the marks that can cover a message in it. */
const lineage = (topic: string) =>
	topic
		.split("/")
		.reduce<ReadonlyArray<string>>(
			(paths, part, index) => [...paths, index === 0 ? part : `${paths.at(-1)}/${part}`],
			[""],
		);

/**
 * Posting activity per author and read progress per session, for the board's agents view. Joining and token use
 * belong to boot's /_boot/tokens, whose family ids are the sessions here.
 */
export default function agents(api: Api) {
	api.route("GET", "/api/agents/activity", {
		description:
			"Count each author's published messages: total, last 24 hours and last 7 days, with the last post time and whether any came through the MCP extension. Also report, per session (a token family), how many published messages other authors wrote that its read marks cover and how many they do not. Requires read.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const now = (yield* DateTime.nowAsDate).getTime();
				const result = yield* ctx.read((fence) =>
					Effect.gen(function* () {
						const marks = yield* ctx.db`SELECT instance,topic,seq FROM ${ctx.db("reads")}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Mark))),
						);
						const byAgent = new Map<string, Activity>();
						const authorOf = new Map<string, string>();
						const lineages = new Map<string, ReadonlyArray<string>>();
						const seen: Array<{
							readonly lineage: ReadonlyArray<string>;
							readonly seq: number;
							readonly agent: string;
						}> = [];
						let cursor = 0;
						// Like standup.ts, this pages every published message in one snapshot. Deleted messages are not listed.
						while (cursor < fence) {
							const page = yield* ctx.messages.query({ since: cursor, limit: 200 });
							for (const message of page.items) {
								const age = now - message.created_at;
								const previous = byAgent.get(message.agent);
								byAgent.set(message.agent, {
									agent: message.agent,
									posts: (previous?.posts ?? 0) + 1,
									posts_24h: (previous?.posts_24h ?? 0) + (age < day ? 1 : 0),
									posts_7d: (previous?.posts_7d ?? 0) + (age < 7 * day ? 1 : 0),
									last_post_at: Math.max(previous?.last_post_at ?? message.created_at, message.created_at),
									mcp: (previous?.mcp ?? false) || message.instance.startsWith("extension:mcp:"),
								});
								authorOf.set(message.instance, message.agent);
								const known = lineages.get(message.topic) ?? lineage(message.topic);
								lineages.set(message.topic, known);
								seen.push({ lineage: known, seq: message.seq, agent: message.agent });
							}
							cursor = page.cursor;
						}
						const instances = [...new Set(marks.map((mark) => mark.instance))];
						const reads = instances.map((instance): Reads => {
							const own = new Map(
								marks.filter((mark) => mark.instance === instance).map((mark) => [mark.topic, mark.seq]),
							);
							// A session's own posts are never unread to it; its name is known once it has posted.
							const others = seen.filter((message) => message.agent !== authorOf.get(instance));
							const read = others.filter((message) =>
								message.lineage.some((path) => (own.get(path) ?? -1) >= message.seq),
							).length;
							return { instance, read, unread: others.length - read, topics: own.size };
						});
						return { items: [...byAgent.values()].sort((a, b) => b.last_post_at - a.last_post_at), reads };
					}),
				);
				return Response.json({ as_of: now, ...result });
			}),
	});
}
