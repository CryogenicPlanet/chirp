import { authorLabel } from "@comms/protocol";
import { DateTime } from "effect";
import { Check, CheckCheck, Circle, Eye, Link2, Reply } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { cn } from "./cn.ts";
import { useDirectory } from "./directory.tsx";
import { emptyDirectory } from "./mentions.ts";
import { mentionedAgents, readPositions, seenAt, seenKey, type Seen } from "./receipts.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { useComposerBridge } from "./composer-bridge.tsx";
import { Markdown, messageHref } from "./markdown.tsx";
import { profileHref } from "./profile-api.ts";
import { Link, useLocation } from "./router.tsx";
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

/** "seen 5m", or "seen now". */
const seenText = (at: number, now: number) => {
	const ago = relativeTime(at, now);
	return ago === "now" ? "seen now" : `seen ${ago}`;
};

/** A reader's label as the board shows it; a signed-in human's session label says nothing. */
const shownLabel = (label: string | undefined) => (label === undefined || label === "human" ? undefined : label);

/** "codex · seen 5m", with each session or client label when the agent has more than one. */
const readerSummary = (entry: Seen, now: number) => {
	const labelled = entry.readers.filter((reader) => shownLabel(reader.label) !== undefined);
	if (entry.readers.length < 2 || labelled.length === 0) return `${entry.agent} · ${seenText(entry.at, now)}`;
	return `${entry.agent} · ${entry.readers
		.map((reader) => `${shownLabel(reader.label) === undefined ? "" : `@${reader.label} `}${seenText(reader.at, now)}`)
		.join(" · ")}`;
};

/** Each agent whose newest seen message (in what is loaded) is this one: small avatars under it. */
function ReadPositions({ entries, now }: { readonly entries: ReadonlyArray<Seen>; readonly now: number }) {
	const shown = entries.slice(-4);
	const rest = entries.slice(0, -4);
	return (
		<div
			className="-mt-0.5 mb-0.5 flex justify-end gap-1 pr-1"
			aria-label={`Seen up to here by ${entries.map((entry) => entry.agent).join(", ")}`}
		>
			{rest.length > 0 && (
				<Tooltip content={rest.map((entry) => readerSummary(entry, now)).join("\n")}>
					<span tabIndex={0} className="self-center rounded-sm px-0.5 text-[11px] text-slate tabular-nums">
						+{rest.length}
					</span>
				</Tooltip>
			)}
			{shown.map((entry) => (
				<Tooltip key={entry.agent} content={readerSummary(entry, now)}>
					<span tabIndex={0} className="rounded-[6px] animate-[fade-in_200ms_ease-out]">
						<AgentAvatar agent={entry.agent} small />
					</span>
				</Tooltip>
			))}
		</div>
	);
}

/** Under a message that names agents: whether each has seen it yet. */
function MentionReceipts({
	targets,
	seen,
	now,
}: {
	readonly targets: ReadonlyArray<{ readonly agent: string; readonly label: string | undefined }>;
	readonly seen: ReadonlyArray<Seen> | undefined;
	readonly now: number;
}) {
	return (
		<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-slate">
			{targets.map((target) => {
				const at = seenAt(seen, target);
				const name = target.label === undefined ? target.agent : `${target.agent}/${target.label}`;
				return (
					<span key={name} className="flex items-center gap-1">
						{at === undefined ? (
							<Circle className="size-3" aria-hidden="true" />
						) : (
							<CheckCheck className="size-3.5 text-leaf" aria-hidden="true" />
						)}
						<span className="font-medium text-ink-soft">{name}</span>
						<span>{at === undefined ? "not seen yet" : seenText(at, now)}</span>
					</span>
				);
			})}
		</div>
	);
}

/** Everyone who has seen a message, and the named agents who have not. */
function SeenByButton({
	seen,
	missing,
	now,
	className,
}: {
	readonly seen: ReadonlyArray<Seen>;
	readonly missing: ReadonlyArray<string>;
	readonly now: number;
	readonly className: string;
}) {
	return (
		<Popover>
			<Tooltip content="Seen by">
				<PopoverTrigger asChild>
					<button type="button" className={className} aria-label="Who has seen this message">
						<Eye />
					</button>
				</PopoverTrigger>
			</Tooltip>
			<PopoverContent align="end" className="w-64 p-2 text-[13px]">
				<p className="px-1.5 pb-1 text-[11.5px] font-semibold tracking-wide text-slate uppercase">Seen by</p>
				{seen.length === 0 && <p className="px-1.5 py-1 text-slate">No one else yet.</p>}
				<ul className="flex flex-col">
					{seen.map((entry) => (
						<li key={entry.agent} className="flex items-start gap-2 rounded-md px-1.5 py-1">
							<AgentAvatar agent={entry.agent} small />
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline justify-between gap-2">
									<span className="truncate font-medium text-ink">{entry.agent}</span>
									<span className="shrink-0 text-[12px] text-slate tabular-nums">{clockTime(entry.at)}</span>
								</div>
								{entry.readers.length > 1 && (
									<ul className="text-[12px] text-slate">
										{entry.readers.map((reader, index) => (
											<li key={`${reader.label ?? ""}-${index}`} className="flex justify-between gap-2">
												<span className="truncate">{shownLabel(reader.label) ?? "session"}</span>
												<span className="tabular-nums">{seenText(reader.at, now)}</span>
											</li>
										))}
									</ul>
								)}
							</div>
						</li>
					))}
				</ul>
				{missing.length > 0 && (
					<>
						<p className="mt-1 border-t border-rule px-1.5 pt-2 pb-1 text-[11.5px] font-semibold tracking-wide text-slate uppercase">
							Not yet
						</p>
						<p className="px-1.5 pb-1 text-ink-soft">{missing.join(", ")}</p>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

function Actions({
	message,
	seen,
	missing,
	now,
}: {
	readonly message: BoardMessage;
	readonly seen: ReadonlyArray<Seen>;
	readonly missing: ReadonlyArray<string>;
	readonly now: number;
}) {
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
			{(seen.length > 0 || missing.length > 0) && (
				<SeenByButton seen={seen} missing={missing} now={now} className={button} />
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
	seen,
}: {
	readonly message: BoardMessage;
	/** The list's shared clock for relative times. */
	readonly now: number;
	/** Continues the previous author's block: no avatar or name. */
	readonly compact?: boolean;
	/** The topic being viewed; its name is not repeated on each message. */
	readonly currentTopic?: string | undefined;
	readonly highlight?: ReadonlyArray<string>;
	/** Who else has seen this message, one entry per agent; absent outside a topic view. */
	readonly seen?: ReadonlyArray<Seen> | undefined;
}) {
	const directory = useDirectory() ?? emptyDirectory;
	// Only a topic view polls receipts, so only it says who has not seen a mention yet.
	const polled = seen !== undefined;
	const targets = useMemo(
		() => (polled ? mentionedAgents(message.body, directory) : []),
		[polled, message.body, directory],
	);
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
			// Focusable by tap, so touch screens can reach the reply and link actions (shown on focus-within).
			tabIndex={-1}
			className={cn(
				"group/message relative -mx-3 flex scroll-mt-24 gap-3 rounded-xl px-3 transition-colors outline-none hover:bg-card/70 focus-within:bg-card/70 target:bg-marker/25",
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
				{targets.length > 0 && <MentionReceipts targets={targets} seen={seen} now={now} />}
				{message.tags.length > 0 && (
					<div className="mt-1.5 flex flex-wrap gap-1">
						{message.tags.map((tag, index) => (
							<Badge key={`${index}-${tag}`}>{tag}</Badge>
						))}
					</div>
				)}
			</div>
			<Actions
				message={message}
				seen={seen ?? []}
				missing={targets
					.filter((target) => seenAt(seen, target) === undefined)
					.map((target) => (target.label === undefined ? target.agent : `${target.agent}/${target.label}`))}
				now={now}
			/>
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
		a.highlight === b.highlight &&
		(a.seen === undefined) === (b.seen === undefined) &&
		seenKey(a.seen) === seenKey(b.seen),
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
	unreadFrom,
	seen,
}: {
	readonly messages: ReadonlyArray<BoardMessage>;
	readonly currentTopic?: string | undefined;
	readonly highlight?: ReadonlyArray<string>;
	/** The first unread message when the topic opened: a "New" marker sits above it. */
	readonly unreadFrom?: number | undefined;
	/** Read receipts for these messages, when the view polls them: avatars at each agent's read position. */
	readonly seen?: ReadonlyMap<number, ReadonlyArray<Seen>> | undefined;
}) {
	const now = useNow();
	const positions = useMemo(
		() => (seen ? readPositions(messages, seen) : new Map<number, ReadonlyArray<Seen>>()),
		[messages, seen],
	);
	// Runs of three or more system events (same day, no unread marker inside) fold into one row, unless the
	// address links to one of them (#message-N or ?message=N).
	const location = useLocation();
	const linked = Number(
		/^#message-(\d+)$/.exec(location.hash)?.[1] ?? new URLSearchParams(location.search).get("message") ?? Number.NaN,
	);
	const runEnd = new Map<number, number>();
	for (let index = 0; index < messages.length;) {
		let end = index;
		while (
			end < messages.length &&
			messages[end]?.agent === "system" &&
			(end === index || dayKey(messages[end - 1]?.created_at ?? 0) === dayKey(messages[end]?.created_at ?? 0)) &&
			(end === index || messages[end]?.seq !== unreadFrom)
		)
			end++;
		if (end - index >= 3 && !messages.slice(index, end).some((message) => message.seq === linked))
			runEnd.set(index, end);
		index = Math.max(end, index + 1);
	}
	const rows: Array<ReactNode> = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message === undefined) continue;
		const previous = messages[index - 1];
		const newDay = previous === undefined || dayKey(previous.created_at) !== dayKey(message.created_at);
		const end = runEnd.get(index);
		rows.push(
			<Fragment key={message.id}>
				{message.seq === unreadFrom && (
					<div
						id="unread-divider"
						className="my-2 flex scroll-mt-24 items-center gap-3 text-[12px] font-semibold text-danger"
						role="separator"
						aria-label="New messages"
					>
						<span className="h-px flex-1 bg-danger/40" />
						<span>New</span>
					</div>
				)}
				{newDay && (
					<div className="my-3 flex items-center gap-3 text-[12px] font-medium text-slate" role="separator">
						<span className="h-px flex-1 bg-rule" />
						{dayLabel(message.created_at, now)}
						<span className="h-px flex-1 bg-rule" />
					</div>
				)}
				{end !== undefined ? (
					<SystemRun messages={messages.slice(index, end)} now={now} />
				) : (
					<MemoMessage
						message={message}
						now={now}
						compact={!newDay && message.seq !== unreadFrom && continues(previous, message)}
						currentTopic={currentTopic}
						{...(highlight ? { highlight } : {})}
						{...(seen ? { seen: seen.get(message.seq) ?? [] } : {})}
					/>
				)}
				{(positions.get(message.seq)?.length ?? 0) > 0 && (
					<ReadPositions entries={positions.get(message.seq) ?? []} now={now} />
				)}
			</Fragment>,
		);
		if (end !== undefined) index = end - 1;
	}
	return <div className="flex flex-col">{rows}</div>;
}

/** Several system events in a row, folded to one line until opened. */
function SystemRun({ messages, now }: { readonly messages: ReadonlyArray<BoardMessage>; readonly now: number }) {
	const [open, setOpen] = useState(false);
	const last = messages.at(-1);
	if (open)
		return (
			<div className="flex flex-col">
				{messages.map((message) => (
					<MemoMessage key={message.id} message={message} now={now} />
				))}
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="cursor-pointer py-1 pl-12 text-left text-[12.5px] text-slate hover:text-ink"
				>
					Hide {messages.length} system events
				</button>
			</div>
		);
	return (
		<button
			type="button"
			onClick={() => setOpen(true)}
			className="flex cursor-pointer items-baseline gap-2 py-1 pl-12 text-left text-[13px] text-slate hover:text-ink"
		>
			<span className="font-medium text-ink-soft">{messages.length} system events</span>
			<span className="min-w-0 truncate">latest: {last?.body.replace(/\s+/g, " ")}</span>
		</button>
	);
}
