import { isDescendant } from "@comms/storage/dialect";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { KernelError } from "../../kernel/boot-channel.ts";

import { Messages, StoredMessage, topicPathDetail, validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";
import { publishedTopics } from "./published-topics.ts";
import { publishedActivity, publishedMessages } from "./published-messages.ts";
import { Pages } from "./pages.ts";

const PublishedTopic = Schema.Struct({
	path: Schema.String,
	name: Schema.String,
	meta: Schema.fromJsonString(Schema.JsonObject),
	archived_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});
const TopicActivity = Schema.Struct({ topic: Schema.String, last_seq: Schema.Int, unread: Schema.Int });
/** The path itself and every ancestor, exactly the paths `isDescendant` or equality would match. */
const lineage = (path: string) => [path, ...Array.from(path.matchAll(/\//g), (match) => path.slice(0, match.index))];
const covered = (path: string, roots: ReadonlySet<string>) => lineage(path).some((ancestor) => roots.has(ancestor));
export const makeTopics = (sql: SqlClient.SqlClient, read: Messages["Service"]["read"], pages: Pages["Service"]) => {
	const detail = (identity: Identity, path: string, depth = 1, archived = false) =>
		read((ceiling) =>
			Effect.gen(function* () {
				if (path !== "" && !validTopic(path))
					return yield* new KernelError({ code: "input_invalid", detail: topicPathDetail("path") });
				const page = yield* pages.topic(path, depth);
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`SELECT epoch FROM kernel_writer`;

						const topics =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path,name,meta,archived_at,deleted_at FROM visible_topics`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PublishedTopic))),
							);
						const deletedTopics = topics.filter((row) => row.deleted_at !== null);
						const archivedTopics = topics.filter((row) => row.archived_at !== null);
						const deleted = new Set(deletedTopics.map((row) => row.path));
						const archivedPaths = new Set(archivedTopics.map((row) => row.path));
						if (covered(path, deleted)) return yield* new KernelError({ code: "topic_not_found" });
						// One pass over the subtree's messages, grouped by topic, joined to each topic's effective read
						// mark. Ancestors take their totals from these groups below, instead of a correlated scan per topic.
						// The mark list reads topics from the index, so the message scan is not materialized twice.
						// Root and subtree reads are separate statements: a parameterized `path=''` test leaves a cached
						// generic plan guessing at the row count, which on PostgreSQL chose a spilling sort.
						const scope = (column: string) =>
							path === "" ? sql`1=1` : sql`(${sql(column)}=${path} OR ${isDescendant(sql, sql(column), path)})`;
						const activity =
							yield* sql`SELECT a.topic,MAX(a.seq) AS last_seq,COUNT(CASE WHEN a.deleted_at IS NULL AND a.seq>k.mark THEN 1 END) AS unread FROM (${publishedActivity(sql, ceiling)}) a
   JOIN (SELECT t.topic,COALESCE(MAX(r.seq),0) AS mark FROM (SELECT DISTINCT topic FROM messages WHERE seq<=${ceiling} AND ${scope("topic")}) t
    LEFT JOIN ${sql("reads")} r ON r.instance=${identity.instance} AND (r.topic='' OR r.topic=t.topic OR ${isDescendant(sql, sql("t.topic"), sql("r.topic"))}) GROUP BY t.topic) k ON k.topic=a.topic
   WHERE ${scope("a.topic")} GROUP BY a.topic`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TopicActivity))),
							);
						const lastSeq = new Map<string, number>();
						const unread = new Map<string, number>();
						for (const group of activity) {
							// Messages under a deleted topic are not published; under an archived one they are never unread.
							if (covered(group.topic, deleted)) continue;
							const counted = !covered(group.topic, archivedPaths);
							for (const ancestor of lineage(group.topic)) {
								lastSeq.set(ancestor, Math.max(lastSeq.get(ancestor) ?? 0, group.last_seq));
								if (counted) unread.set(ancestor, (unread.get(ancestor) ?? 0) + group.unread);
							}
						}
						const rows = topics
							.filter(
								(row) =>
									!covered(row.path, deleted) &&
									(path === "" || row.path === path || row.path.startsWith(`${path}/`)) &&
									(archived || row.path === path || !covered(row.path, archivedPaths)),
							)
							.map((row) => ({
								path: row.path,
								name: row.name,
								meta: row.meta,
								archived_at: row.archived_at,
								last_seq: lastSeq.get(row.path) ?? 0,
								unread: unread.get(row.path) ?? 0,
							}));
						const visible = [...rows];
						for (const directory of page.directories) {
							if (
								visible.some((row) => row.path === directory) ||
								deletedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)) ||
								(!archived &&
									archivedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)))
							)
								continue;
							visible.push({
								path: directory,
								name: directory.split("/").at(-1) ?? directory,
								meta: {},
								last_seq: 0,
								unread: 0,
								archived_at: null,
							});
						}
						visible.sort((a, b) => b.last_seq - a.last_seq || a.path.localeCompare(b.path));
						const own = visible.find((row) => row.path === path);
						if (path !== "" && !own && !page.exists) return yield* new KernelError({ code: "topic_not_found" });
						const segments = path === "" ? 0 : path.split("/").length;
						const subtopics = visible.filter(
							(row) => row.path !== path && row.path.split("/").length <= segments + depth,
						);
						const recent =
							yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}), visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE deleted_at IS NULL AND seq<=${ceiling} AND ${path === "" ? sql`NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (visible_messages.topic=a.path OR ${isDescendant(sql, sql("visible_messages.topic"), sql("a.path"))}))` : sql`topic=${path}`} ORDER BY seq DESC LIMIT 100`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
							);
						return {
							path,
							meta: own?.meta ?? {},
							archived_at: own?.archived_at ?? null,
							archived_root:
								archivedTopics
									.filter((row) => path === row.path || path.startsWith(`${row.path}/`))
									.sort((left, right) => left.path.length - right.path.length)[0]?.path ?? null,
							subtopics,
							messages: [...recent].reverse(),
							fence: ceiling,
							unread:
								own?.unread ?? rows.filter((row) => !row.path.includes("/")).reduce((sum, row) => sum + row.unread, 0),
							index: page.index,
							pages: page.pages,
						};
					}),
				);
			}),
		);
	return { detail };
};
const make = Effect.gen(function* () {
	return makeTopics(yield* SqlClient.SqlClient, (yield* Messages).read, yield* Pages);
});
export class Topics extends Context.Service<Topics, Effect.Success<typeof make>>()("comms/server/Topics") {}
export const layer = Layer.effect(Topics, make);
