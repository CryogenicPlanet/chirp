import { isDescendant, on } from "@comms/storage/dialect";
import type { SeenBy } from "@comms/protocol/messages";
import { DateTime, Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Mutate } from "../../kernel/mutate.ts";
import type { Identity } from "../../kernel/identity.ts";

export const ReadInput = Schema.Struct({ topic: Schema.String, seq: Schema.Int });
export const ReadResult = ReadInput;
// Returned messages already prove the publication ceiling. View metadata has no event or receipt.
export const markRead = (sql: SqlClient, mutate: Mutate, identity: Identity, input: typeof ReadInput.Type) =>
	mutate({
		body: () =>
			Effect.gen(function* () {
				yield* sql`INSERT INTO ${sql("reads")}(instance,topic,seq) VALUES(${identity.instance},${input.topic},${input.seq}) ${on(sql, { sqlite: () => sql`ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`, pg: () => sql`ON CONFLICT(instance,topic) DO UPDATE SET seq=excluded.seq WHERE reads.seq<excluded.seq`, mysql: () => sql`ON DUPLICATE KEY UPDATE seq=GREATEST(seq,${input.seq})` })}`;
				return { outcome: undefined, events: [] };
			}),
	});

const Seqs = Schema.Array(Schema.Struct({ seq: Schema.Int }));
const SeenRow = Schema.Struct({
	seq: Schema.Int,
	instance: Schema.String,
	label: Schema.String,
	agent: Schema.String,
	seen_at: Schema.Int,
});
const SeenRows = Schema.Array(SeenRow);
/** One reader of a message: a session, or one client label behind a shared MCP connection. */
export interface Reader {
	readonly instance: string;
	readonly label?: string | undefined;
}
const seenBy = (row: typeof SeenRow.Type): typeof SeenBy.Type => ({
	instance: row.instance,
	agent: row.agent,
	...(row.label === "" ? {} : { label: row.label }),
	at: row.seen_at,
});

/**
 * Record that a view returned these messages to this reader, keeping the first time. The author's own messages and
 * unknown sequences record nothing. Like read marks, this is view metadata: no event and no mutation receipt. A view
 * that returns only messages already recorded writes nothing.
 */
export const markSeen = (sql: SqlClient, mutate: Mutate, identity: Identity, seqs: ReadonlyArray<number>) =>
	Effect.gen(function* () {
		if (seqs.length === 0) return;
		const label = identity.label ?? "";
		const missing =
			yield* sql`SELECT m.seq FROM messages m WHERE ${sql.in("m.seq", [...new Set(seqs)])} AND m.instance<>${identity.instance} AND NOT EXISTS(SELECT 1 FROM seen s WHERE s.seq=m.seq AND s.instance=${identity.instance} AND s.label=${label})`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Seqs)),
			);
		if (missing.length === 0) return;
		const at = (yield* DateTime.nowAsDate).getTime();
		const rows = missing.map(({ seq }) => ({
			seq,
			instance: identity.instance,
			label,
			agent: identity.agent,
			seen_at: at,
		}));
		yield* mutate({
			body: () =>
				Effect.gen(function* () {
					yield* sql`INSERT INTO seen ${sql.insert(rows)} ${on(sql, { sqlite: () => sql`ON CONFLICT(seq,instance,label) DO NOTHING`, pg: () => sql`ON CONFLICT(seq,instance,label) DO NOTHING`, mysql: () => sql`ON DUPLICATE KEY UPDATE seen_at=seen_at` })}`;
					return { outcome: undefined, events: [] };
				}),
		});
	});

/**
 * Attach who else each message was shown to, first reader first, in one query. The viewer is left out: it is reading
 * the message now. Messages no other reader has seen carry no `seen_by`.
 */
export const withSeenBy = <M extends { readonly seq: number }>(
	sql: SqlClient,
	viewer: Reader,
	items: ReadonlyArray<M>,
) =>
	Effect.gen(function* () {
		const rows =
			items.length === 0
				? []
				: yield* sql`SELECT seq,instance,label,agent,seen_at FROM seen WHERE ${sql.in(
						"seq",
						items.map((item) => item.seq),
					)} AND NOT (instance=${viewer.instance} AND label=${viewer.label ?? ""}) ORDER BY seq,seen_at,instance,label`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SeenRows)),
					);
		const bySeq = Map.groupBy(rows, (row) => row.seq);
		return items.map((item): M & { readonly seen_by?: ReadonlyArray<typeof SeenBy.Type> } => {
			const seen = bySeq.get(item.seq);
			return seen ? { ...item, seen_by: seen.map(seenBy) } : item;
		});
	});

/** At most this many receipts per poll, newest messages first; a topic view holds about 100 messages. */
export const receiptLimit = 2000;

/**
 * The receipts on a topic's live messages from sequence `from` on, for a view that already holds those messages and
 * polls for who has seen them since. The viewer is left out. Reading records nothing.
 */
export const topicReceipts = (
	sql: SqlClient,
	viewer: Reader,
	input: { readonly topic: string; readonly recursive: boolean; readonly from: number },
) =>
	sql`SELECT s.seq,s.instance,s.label,s.agent,s.seen_at FROM seen s JOIN messages m ON m.seq=s.seq WHERE m.deleted_at IS NULL AND s.seq>=${input.from} AND (m.topic=${input.topic} OR ${input.recursive ? 1 : 0}=1 AND ${isDescendant(sql, sql("m.topic"), input.topic)}) AND NOT (s.instance=${viewer.instance} AND s.label=${viewer.label ?? ""}) ORDER BY s.seq DESC,s.seen_at,s.instance,s.label LIMIT ${receiptLimit + 1}`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(SeenRows)),
		Effect.map((rows) => ({
			topic: input.topic,
			from: input.from,
			items: rows
				.slice(0, receiptLimit)
				.toSorted((a, b) => a.seq - b.seq || a.seen_at - b.seen_at)
				.map((row) => ({ seq: row.seq, ...seenBy(row) })),
			truncated: rows.length > receiptLimit,
		})),
	);
