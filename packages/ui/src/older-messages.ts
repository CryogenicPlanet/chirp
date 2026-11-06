import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardMessage } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";

const pageSize = 50;

/**
 * Pages backwards from the oldest message a view shows (newest + before), for infinite scroll upward. Older
 * pages never mark reads. Resets when the topic changes.
 */
export function useOlderMessages(path: string | null, oldestShown: number | undefined) {
	const client = useBoardClient();
	const [older, setOlder] = useState<ReadonlyArray<BoardMessage>>([]);
	const [done, setDone] = useState(false);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const inFlight = useRef<AbortController | null>(null);
	useEffect(() => {
		inFlight.current?.abort();
		inFlight.current = null;
		setOlder([]);
		setDone(false);
		setLoading(false);
		setFailed(false);
	}, [path]);
	useEffect(() => () => inFlight.current?.abort(), []);
	const before = older[0]?.seq ?? oldestShown;
	const loadOlder = useCallback(() => {
		if (path === null || before === undefined || done || inFlight.current !== null) return;
		const controller = new AbortController();
		inFlight.current = controller;
		setLoading(true);
		setFailed(false);
		void Effect.runPromise(
			client.read(
				client.messages({
					since: 0,
					newest: "1",
					before,
					limit: pageSize,
					mark: "0",
					...(path === "" ? {} : { topic: path }),
				}),
			),
			{ signal: controller.signal },
		).then(
			(page) => {
				if (controller.signal.aborted) return;
				inFlight.current = null;
				setLoading(false);
				setOlder((previous) => [...page.items, ...previous]);
				if (page.items.length < pageSize) setDone(true);
			},
			() => {
				if (controller.signal.aborted) return;
				inFlight.current = null;
				setLoading(false);
				setFailed(true);
			},
		);
	}, [client, path, before, done]);
	return { older, loadOlder, done, loading, failed };
}
