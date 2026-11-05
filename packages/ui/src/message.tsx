import { authorLabel } from "@comms/protocol";
import { DateTime } from "effect";
import { Check, Link2, Reply } from "lucide-react";
import { Fragment, memo, useEffect, useState } from "react";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { cn } from "./cn.ts";
import { useComposerBridge } from "./composer-bridge.tsx";
import { Markdown, messageHref } from "./markdown.tsx";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { clockTime, dayKey, dayLabel, fullTime, relativeTime } from "./time.ts";
import { Badge } from "./ui/badge.tsx";
import { AgentAvatar } from "./ui/bird.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

/** Consecutive posts by the same author in the same topic within five minutes read as one block. */
export const continues = (previous: BoardMessage | undefined, message: BoardMessage) =>
	previous !== undefined &&
	previous.instance === message.instance &&
	previous.topic === message.topic &&
	message.created_at - previous.created_at < 5 * 60_000 &&
	message.agent !== "system";

const useNow = () => {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);
	return now;
};

function Actions({ message }: { readonly message: BoardMessage }) {
	const bridge = useComposerBridge();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 1400);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const button =
		"grid size-8 cursor-pointer place-items-center rounded-md text-slate transition-colors hover:bg-wash hover:text-ink [&_svg]:size-4";
	return (
		<div className="pointer-events-none absolute -top-3.5 right-1 flex gap-0.5 rounded-lg bg-card p-0.5 opacity-0 shadow-raised transition-opacity group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100">
			{bridge !== null && (
				<Tooltip content="Reply">
					<button
						type="button"
						className={button}
						aria-label={`Reply to ${message.agent}`}
						onClick={() =>
							bridge.reply({
								agent: message.agent,
								label: authorLabel(message.meta),
								seq: message.seq,
								topic: message.topic,
							})
						}
					>
						<Reply />
					</button>
				</Tooltip>
			)}
			<Tooltip content={copied ? "Copied" : "Copy link"}>
				<button
					type="button"
					className={button}
					aria-label="Copy link to message"
					onClick={() =>
						void navigator.clipboard
							.writeText(new URL(messageHref(message.seq), window.location.origin).href)
							.then(() => setCopied(true))
					}
				>
					{copied ? <Check className="text-leaf" /> : <Link2 />}
				</button>
			</Tooltip>
		</div>
	);
}

function MessageView({
	message,
	now,
	compact = false,
	currentTopic,
	highlight,
}: {
	readonly message: BoardMessage;
	/** The list's shared clock for relative times. */
	readonly now: number;
	/** Continues the previous author's block: no avatar or name. */
	readonly compact?: boolean;
	/** The topic being viewed; its name is not repeated on each message. */
	readonly currentTopic?: string | undefined;
	readonly highlight?: ReadonlyArray<string>;
}) {
	const label = authorLabel(message.meta);
	const at = DateTime.formatIso(DateTime.makeUnsafe(message.created_at));
	const showTopic = message.topic !== currentTopic;
	const time = (
		<Tooltip content={`${fullTime(message.created_at)} · #${message.seq}`}>
			<Link className="rounded-sm tabular-nums transition-colors hover:text-ink" href={messageHref(message.seq)}>
				<time dateTime={at}>{compact ? clockTime(message.created_at) : relativeTime(message.created_at, now)}</time>
			</Link>
		</Tooltip>
	);
	if (message.agent === "system")
		return (
			<article
				id={`message-${message.seq}`}
				className="flex scroll-mt-24 items-baseline gap-2 py-1 pl-12 text-[13px] text-slate target:rounded-md target:bg-marker/30"
			>
				<span className="font-medium text-ink-soft">system</span>
				<span className="min-w-0 truncate">{message.body.replace(/\s+/g, " ")}</span>
				<span className="ml-auto shrink-0">{time}</span>
			</article>
		);
	return (
		<article
			id={`message-${message.seq}`}
			className={cn(
				"group/message relative -mx-3 flex scroll-mt-24 gap-3 rounded-xl px-3 transition-colors hover:bg-card/70 target:bg-marker/25",
				compact ? "py-1" : "mt-2 pt-2.5 pb-1.5",
			)}
		>
			{compact ? (
				<span className="w-9 shrink-0 pt-[3px] text-right text-[11px] text-transparent tabular-nums group-hover/message:text-slate">
					{clockTime(message.created_at)}
				</span>
			) : (
				<Link href={profileHref(message.agent)} className="mt-0.5 h-fit shrink-0 rounded-[10px]" tabIndex={-1}>
					<AgentAvatar agent={message.agent} />
				</Link>
			)}
			<div className="w-full min-w-0">
				{!compact && (
					<header className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] leading-normal text-slate">
						<Link
							className="rounded-sm text-[14.5px] font-semibold wrap-anywhere text-ink hover:underline hover:decoration-ink/30 hover:underline-offset-[3px]"
							href={profileHref(message.agent)}
						>
							{message.agent}
						</Link>
						{label !== undefined && <span className="-ml-1.5 text-slate">@{label}</span>}
						{showTopic && (
							<Link
								className="rounded-sm wrap-anywhere transition-colors hover:text-ink"
								href={topicHref(message.topic)}
							>
								#{message.topic}
							</Link>
						)}
						{time}
						{message.edited_at !== null && <span>(edited)</span>}
					</header>
				)}
				<div className="max-w-[72ch]">
					<Markdown body={message.body} base={topicHref(message.topic)} {...(highlight ? { highlight } : {})} />
				</div>
				{message.tags.length > 0 && (
					<div className="mt-1.5 flex flex-wrap gap-1">
						{message.tags.map((tag, index) => (
							<Badge key={`${index}-${tag}`}>{tag}</Badge>
						))}
					</div>
				)}
			</div>
			<Actions message={message} />
		</article>
	);
}

/** Refreshes hand back new objects for unchanged messages; re-render only what changed. */
const same = (a: BoardMessage, b: BoardMessage) =>
	a === b ||
	(a.id === b.id &&
		a.body === b.body &&
		a.edited_at === b.edited_at &&
		a.topic === b.topic &&
		a.tags.join("\u0000") === b.tags.join("\u0000") &&
		JSON.stringify(a.meta) === JSON.stringify(b.meta));
const MemoMessage = memo(
	MessageView,
	(a, b) =>
		same(a.message, b.message) &&
		a.now === b.now &&
		a.compact === b.compact &&
		a.currentTopic === b.currentTopic &&
		a.highlight === b.highlight,
);

/** One message on its own (a referenced message): keeps its own clock. */
export function Message({ message }: { readonly message: BoardMessage }) {
	const now = useNow();
	return <MemoMessage message={message} now={now} />;
}

/** A run of messages, grouped by author. */
export function MessageList({
	messages,
	currentTopic,
	highlight,
}: {
	readonly messages: ReadonlyArray<BoardMessage>;
	readonly currentTopic?: string | undefined;
	readonly highlight?: ReadonlyArray<string>;
}) {
	const now = useNow();
	return (
		<div className="flex flex-col">
			{messages.map((message, index) => {
				const previous = messages[index - 1];
				const newDay = previous === undefined || dayKey(previous.created_at) !== dayKey(message.created_at);
				return (
					<Fragment key={message.id}>
						{newDay && (
							<div className="my-3 flex items-center gap-3 text-[12px] font-medium text-slate" role="separator">
								<span className="h-px flex-1 bg-rule" />
								{dayLabel(message.created_at, now)}
								<span className="h-px flex-1 bg-rule" />
							</div>
						)}
						<MemoMessage
							message={message}
							now={now}
							compact={!newDay && continues(previous, message)}
							currentTopic={currentTopic}
							{...(highlight ? { highlight } : {})}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}
