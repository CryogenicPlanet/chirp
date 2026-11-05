import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BoardError } from "./board-api.ts";
import { Button } from "./ui/button.tsx";

/** Busy, timed out, reloading or offline: worth trying again by itself. */
export const transient = (error: BoardError) =>
	error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;

/**
 * Retries transient load failures with backoff (1s, 2s, 4s… up to 20s), so a board that is reloading or briefly
 * busy recovers without anyone pressing a button. Stops on success or a non-transient error.
 */
export function useAutoRetry(error: BoardError | null, retry: () => void) {
	const attempts = useRef(0);
	const [waiting, setWaiting] = useState(false);
	useEffect(() => {
		if (error === null) {
			attempts.current = 0;
			setWaiting(false);
			return;
		}
		if (!transient(error)) {
			setWaiting(false);
			return;
		}
		const delay = Math.min(1000 * 2 ** attempts.current, 20_000);
		attempts.current += 1;
		setWaiting(true);
		const timer = window.setTimeout(retry, delay);
		return () => window.clearTimeout(timer);
	}, [error, retry]);
	return { waiting };
}

const explain = (error: BoardError) =>
	error.status === 0
		? "You look offline, or the board is unreachable."
		: error.status === 408
			? "The board took too long to answer."
			: error.status === 503
				? "The board is busy or restarting."
				: error.message;

/** A failed load: a quiet note over content that is still shown, or a card when there is nothing to show. */
export function LoadProblem({
	error,
	stale,
	retrying,
	onRetry,
}: {
	readonly error: BoardError;
	readonly stale: boolean;
	readonly retrying: boolean;
	readonly onRetry: () => void;
}) {
	if (stale)
		return (
			<p
				role="status"
				className="mb-4 flex items-center gap-2 rounded-lg bg-wash px-3 py-2 text-[13px] text-slate ring-1 ring-rule"
			>
				<RefreshCw className={retrying ? "size-3.5 animate-spin" : "size-3.5"} />
				<span className="min-w-0 flex-1">
					Couldn’t refresh. {explain(error)} {retrying ? "Retrying…" : ""}
				</span>
				{!retrying && (
					<button type="button" onClick={onRetry} className="cursor-pointer font-medium text-ink hover:underline">
						Retry
					</button>
				)}
			</p>
		);
	return (
		<div role="alert" className="rounded-2xl bg-card px-6 py-10 text-center shadow-raised">
			<h2 className="text-[16px] font-semibold text-ink">
				{transient(error) ? "Still loading this topic" : "This topic didn’t load"}
			</h2>
			<p className="mx-auto mt-1.5 max-w-[46ch] text-[14px] leading-relaxed text-slate">
				{explain(error)} {transient(error) && retrying ? "Trying again in a moment." : ""}
			</p>
			<Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
				<RefreshCw className={retrying ? "animate-spin" : ""} />
				Try now
			</Button>
		</div>
	);
}
