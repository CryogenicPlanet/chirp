import type { BoardMessage } from "./board-api.ts";
import { mentionsIn, type Directory } from "./mentions.ts";

/** One reader of one message, as `GET /api/seen` returns it. */
export interface Receipt {
	readonly seq: number;
	readonly instance: string;
	readonly agent: string;
	readonly label?: string | undefined;
	readonly at: number;
}

/** An agent's readers of a message: its sessions and client labels, each with its first-seen time. */
export interface Seen {
	readonly agent: string;
	/** The earliest time any of its readers saw the message. */
	readonly at: number;
	readonly readers: ReadonlyArray<{ readonly label: string | undefined; readonly at: number }>;
}

/** Boot and the board speak for themselves; their reads are not receipts anyone is waiting on. */
const quiet: ReadonlySet<string> = new Set(["system", "boot"]);

/**
 * What a poll knows: receipts per message, and the first sequence it covers completely. A truncated poll (more receipts
 * than one response holds) is cut at its oldest message, so that message and older ones are unknown, not unseen.
 */
export interface Receipts {
	readonly bySeq: ReadonlyMap<number, ReadonlyArray<Seen>>;
	readonly from: number;
}

/** Receipts per message, one entry per agent, first seen first. The viewer's own sessions are left out. */
export const seenByMessage = (
	receipts: ReadonlyArray<Receipt>,
	viewer: string | null,
): ReadonlyMap<number, ReadonlyArray<Seen>> => {
	const bySeq = Map.groupBy(
		receipts.filter((receipt) => receipt.agent !== viewer && !quiet.has(receipt.agent)),
		(receipt) => receipt.seq,
	);
	return new Map(
		[...bySeq].map(([seq, rows]) => [
			seq,
			[...Map.groupBy(rows, (row) => row.agent)]
				.map(([agent, readers]): Seen => {
					const sorted = readers.toSorted((a, b) => a.at - b.at);
					return {
						agent,
						at: sorted[0]?.at ?? 0,
						readers: sorted.map((reader) => ({ label: reader.label, at: reader.at })),
					};
				})
				.toSorted((a, b) => a.at - b.at),
		]),
	);
};

/**
 * Where each agent's avatar sits: under the newest loaded message it has seen. An agent that posted after that is
 * placed at its own post, where its header avatar already shows, so it gets no extra avatar.
 */
export const readPositions = (
	messages: ReadonlyArray<BoardMessage>,
	seen: ReadonlyMap<number, ReadonlyArray<Seen>>,
): ReadonlyMap<number, ReadonlyArray<Seen>> => {
	const latest = new Map<string, { readonly seq: number; readonly seen: Seen | null }>();
	for (const message of messages) {
		// System events fold away in the list, so an avatar placed on one would vanish.
		if (quiet.has(message.agent)) continue;
		for (const entry of seen.get(message.seq) ?? [])
			if ((latest.get(entry.agent)?.seq ?? 0) < message.seq) latest.set(entry.agent, { seq: message.seq, seen: entry });
		if (!quiet.has(message.agent) && (latest.get(message.agent)?.seq ?? 0) < message.seq)
			latest.set(message.agent, { seq: message.seq, seen: null });
	}
	const at = new Map<number, Array<Seen>>();
	for (const { seq, seen: entry } of latest.values()) if (entry !== null) at.set(seq, [...(at.get(seq) ?? []), entry]);
	return at;
};

/** Each agent a message names directly (not @here or a custom group), with the label when it names one instance. */
export const mentionedAgents = (
	body: string,
	directory: Directory,
): ReadonlyArray<{ readonly agent: string; readonly label: string | undefined }> =>
	mentionsIn(body).flatMap((mention) => {
		if (directory.custom.some((item) => item.mention === mention)) return [];
		// @name or @name/label; a deeper path names no instance, so it tracks nothing (as `reachable` treats it).
		const [agent = "", label, ...rest] = mention.slice(1).split("/");
		const known = directory.agents.find((item) => item.name === agent);
		if (!known || rest.length > 0 || agent === directory.self || (label !== undefined && !known.labels.includes(label)))
			return [];
		return [{ agent, label }];
	});

/** When a mentioned agent (or the one instance it names) first saw the message, or undefined while it has not. */
export const seenAt = (
	entries: ReadonlyArray<Seen> | undefined,
	target: { readonly agent: string; readonly label: string | undefined },
): number | undefined => {
	const entry = entries?.find((item) => item.agent === target.agent);
	if (!entry) return undefined;
	if (target.label === undefined) return entry.at;
	return entry.readers.find((reader) => reader.label === target.label)?.at;
};

/** A stable key for memoizing a message row on its receipts. */
export const seenKey = (entries: ReadonlyArray<Seen> | undefined) =>
	entries?.map((entry) => `${entry.agent}:${entry.readers.map((reader) => reader.label ?? "").join(",")}`).join("|") ??
	"";
