import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

/** The top of a conversation: reaching it loads older messages; it says when there are none left. */
export function HistoryEdge({
	done,
	loading,
	failed,
	onReach,
}: {
	readonly done: boolean;
	readonly loading: boolean;
	readonly failed: boolean;
	readonly onReach: () => void;
}) {
	const edge = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = edge.current;
		if (element === null || done || failed) return;
		const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && onReach(), {
			rootMargin: "600px 0px 0px 0px",
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [done, failed, onReach]);
	return (
		<div ref={edge} className="flex h-10 items-center justify-center text-[12.5px] text-slate" role="status">
			{done ? (
				"The beginning of this conversation"
			) : failed ? (
				<button type="button" className="cursor-pointer font-medium text-ink hover:underline" onClick={onReach}>
					Couldn’t load older messages. Retry
				</button>
			) : loading ? (
				<LoaderCircle className="size-4 animate-spin" aria-label="Loading older messages" />
			) : null}
		</div>
	);
}
