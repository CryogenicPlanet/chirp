import { DateTime, Effect } from "effect";
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

/** Posting activity per author, for the board's agents view. Joining and token use belong to boot's /_boot/tokens. */
export default function agents(api: Api) {
	api.route("GET", "/api/agents/activity", {
		description:
			"Count each author's published messages: total, last 24 hours and last 7 days, with the last post time and whether any came through the MCP extension. Requires read.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const now = (yield* DateTime.nowAsDate).getTime();
				const items = yield* ctx.read((fence) =>
					Effect.gen(function* () {
						const byAgent = new Map<string, Activity>();
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
							}
							cursor = page.cursor;
						}
						return [...byAgent.values()].sort((a, b) => b.last_post_at - a.last_post_at);
					}),
				);
				return Response.json({ as_of: now, items });
			}),
	});
}
