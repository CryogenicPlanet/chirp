import { Effect } from "effect";
import type { Api, RequestContext } from "../../packages/server/src/kernel/extension-api.ts";

/**
 * Reply threads. Messages already carry free-form `meta`, so a reply is just an
 * edge: `meta.reply_to` (preferred) or `meta.re` (the convention already in use).
 * This reads those edges as a tree, so following an agent exchange no longer
 * means chasing `#seq` by hand across topics.
 */

type Meta = Readonly<Record<string, unknown>>;
type Scanned = Effect.Success<ReturnType<RequestContext["messages"]["query"]>>["items"][number];

/** A positive integer sequence from meta.reply_to, else meta.re. Anything else is not an edge. */
const parentOf = (meta: Meta): number | null => {
	for (const field of ["reply_to", "re"] as const) {
		const raw = meta[field];
		const seq = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
		if (Number.isInteger(seq) && seq > 0) return seq;
	}
	return null;
};

export default function thread(api: Api) {
	api.route("GET", "/api/thread/:seq", {
		description:
			"Read the reply thread containing a message. Follows meta.reply_to (or meta.re) to its root, then returns that root and every descendant across topics, ordered by sequence, each with parent and depth. Requires read. Peeks only: never advances read marks. Optional since= bounds the scan.",
		scope: "read",
		handler: (_request, ctx) =>
			Effect.gen(function* () {
				const target = Number(ctx.params.seq);
				if (!Number.isInteger(target) || target <= 0)
					return Response.json(
						{ error: { code: "input_invalid", detail: "seq must be a positive integer" } },
						{ status: 400 },
					);
				const requested = Number(ctx.query.since);
				const start = Number.isInteger(requested) && requested > 0 ? requested : 0;

				const scanned = yield* ctx.read((fence) =>
					Effect.gen(function* () {
						const bySeq = new Map<number, Scanned>();
						let cursor = start;
						// Bounded so a pathological cursor can never spin this request forever.
						for (let page = 0; cursor < fence && page < 1000; page += 1) {
							const batch = yield* ctx.messages.query({ since: cursor, limit: 200 });
							for (const message of batch.items) bySeq.set(message.seq, message);
							if (batch.cursor <= cursor) break;
							cursor = batch.cursor;
						}
						return bySeq;
					}),
				);

				const parents = new Map<number, number>();
				for (const [seq, message] of scanned) {
					const parent = parentOf(message.meta);
					if (parent !== null && parent !== seq) parents.set(seq, parent);
				}

				/** Walk to the root, refusing to loop if two messages ever point at each other. */
				const rootOf = (seq: number): number => {
					const seen = new Set<number>([seq]);
					let current = seq;
					for (;;) {
						const parent = parents.get(current);
						if (parent === undefined || seen.has(parent)) return current;
						seen.add(parent);
						current = parent;
					}
				};

				if (!scanned.has(target) && !parents.has(target))
					return Response.json(
						{ error: { code: "not_found", detail: `no message ${target} in the scanned range` } },
						{ status: 404 },
					);

				const root = rootOf(target);
				const depthOf = (seq: number): number => {
					const seen = new Set<number>([seq]);
					let depth = 0;
					let current = seq;
					for (;;) {
						const parent = parents.get(current);
						if (parent === undefined || seen.has(parent)) return depth;
						seen.add(parent);
						current = parent;
						depth += 1;
					}
				};

				const items = Array.from(scanned.values())
					.filter((message) => rootOf(message.seq) === root)
					.sort((left, right) => left.seq - right.seq)
					.map((message) => ({
						seq: message.seq,
						parent: parents.get(message.seq) ?? null,
						depth: depthOf(message.seq),
						topic: message.topic,
						agent: message.agent,
						created_at: message.created_at,
						tags: message.tags,
						meta: message.meta,
						body: message.body,
						deleted_at: message.deleted_at,
					}));

				const topics = Array.from(new Set(items.map((item) => item.topic)));
				return Response.json({ root, target, count: items.length, topics, scanned_from: start, items });
			}),
	});
}
