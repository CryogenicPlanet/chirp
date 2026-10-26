"use client";

import { ArrowUpRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTrack } from "./analytics.tsx";
import { type IssuedSetupCode, openBoardTarget } from "./open-board.ts";

/**
 * Asks Cloud where to sign the owner in, then goes there; `onSetupCode` shows the copy-code panel with the code Cloud issued. An
 * Open can replace the board's code even when it fails, so `onOpening` clears any code on screen first. If Cloud cannot
 * answer, the board's plain address is still offered, as the link this replaced always was.
 */
export function OpenBoardButton({
	boardId,
	hostname,
	className,
	onOpening,
	onSetupCode,
}: {
	readonly boardId: string;
	readonly hostname: string;
	readonly className: string;
	readonly onOpening: () => void;
	readonly onSetupCode: (code: IssuedSetupCode | undefined) => void;
}) {
	const track = useTrack();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	// Stay disabled while the board loads, so a second click cannot replace the setup code; reset if the page is restored.
	useEffect(() => {
		const restore = (event: PageTransitionEvent) => {
			if (event.persisted) setPending(false);
		};
		window.addEventListener("pageshow", restore);
		return () => window.removeEventListener("pageshow", restore);
	}, []);
	const open = async () => {
		setPending(true);
		setError(undefined);
		onOpening();
		track("board_opened", { board_id: boardId });
		try {
			const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/open`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
				cache: "no-store",
			});
			const target = response.ok ? openBoardTarget(await response.json(), hostname) : undefined;
			if (target && "navigate" in target) {
				window.location.assign(target.navigate);
				return;
			}
			if (target) onSetupCode(target.setupCode);
			else
				setError(
					response.status === 401
						? "Your session expired. Sign in to Cloud again."
						: "We couldn't open your board. Check that it is running and try again.",
				);
		} catch {
			setError("We couldn't reach Cloud. Check your connection and try again.");
		}
		setPending(false);
	};
	return (
		<span className="inline-flex flex-col items-end gap-1">
			<button type="button" className={className} disabled={pending} onClick={() => void open()}>
				{pending ? "Opening…" : "Open board"}
				{pending ? (
					<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
				) : (
					<ArrowUpRight className="size-3.5" />
				)}
			</button>
			{error ? (
				<span role="alert" className="max-w-64 text-right text-xs text-destructive">
					{error}{" "}
					<a className="underline" href={`https://${hostname}`}>
						Go to the board instead
					</a>
				</span>
			) : null}
		</span>
	);
}
