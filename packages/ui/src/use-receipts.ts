import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { useBoardClient } from "./board-client.tsx";
import { useDirectory } from "./directory.tsx";
import { boardChanged } from "./live-events.ts";
import { seenByMessage, type Receipts } from "./receipts.ts";
import { useLoad } from "./use-load.ts";

/**
 * Who has seen the open topic's messages from `from` on. Receipts publish no event, so this polls every 15 seconds
 * while the tab is visible, and right away when the board changes. Returns nothing for the root view.
 */
export function useReceipts(path: string | null, from: number | undefined): Receipts | undefined {
	const client = useBoardClient();
	const self = useDirectory()?.self ?? null;
	const request = useMemo(
		() =>
			path && from !== undefined
				? client.receipts(path, from)
				: Atom.make(Effect.succeed({ items: [], truncated: false })),
		[client, path, from],
	);
	const { value, reload } = useLoad(request);
	useEffect(() => {
		if (!path || from === undefined) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") reload();
		}, 15_000);
		window.addEventListener(boardChanged, reload);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener(boardChanged, reload);
		};
	}, [path, from, reload]);
	return useMemo(() => {
		if (!value || from === undefined) return undefined;
		// Truncated: the oldest message in the response may be cut short, so trust only what is newer.
		const oldest = value.items[0]?.seq;
		const covered = value.truncated && oldest !== undefined ? oldest + 1 : from;
		return { bySeq: seenByMessage(value.items, self), from: covered };
	}, [value, self, from]);
}
