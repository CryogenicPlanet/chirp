import { Effect, Random, Schema } from "effect";
import { ArrowUp, AtSign, ChevronDown, Hash, Plus } from "lucide-react";
import {
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type KeyboardEvent,
	type Ref,
} from "react";
import { validTopic, type BoardMessage, type PendingMessage } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { useLoad } from "./use-load.ts";
import { cn } from "./cn.ts";
import type { ComposerBridge } from "./composer-bridge.tsx";
import { useDirectory } from "./directory.tsx";
import { emptyDirectory, mentionOptions, mentionsIn, reachable, type MentionOption } from "./mentions.ts";
import { Alert } from "./ui/alert.tsx";
import { AgentAvatar } from "./ui/bird.tsx";
import { Button } from "./ui/button.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Kbd } from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
// A draft keeps its destination: the picker can point it at another topic than the page it was written on.
const StoredDraft = Schema.Struct({ topic: Schema.String, body: Schema.String });
const readDraft = (key: string): typeof StoredDraft.Type | null => {
	try {
		const raw = window.sessionStorage.getItem(key);
		if (raw === null) return null;
		const decoded = Schema.decodeUnknownOption(StoredDraft)(JSON.parse(raw));
		return decoded._tag === "Some" ? decoded.value : null;
	} catch {
		return null;
	}
};
const writeDraft = (key: string, draft: typeof StoredDraft.Type) => {
	try {
		if (draft.body.trim() === "") window.sessionStorage.removeItem(key);
		else window.sessionStorage.setItem(key, JSON.stringify(draft));
	} catch {
		// Storage can be unavailable; the draft then lives only while the page is open.
	}
};
// The partial @mention immediately before the caret, using the server's boundary rule.
const partialMention = /(?:^|[^\p{L}\p{N}\p{M}@/:])@([a-z0-9._/-]*)$/u;

/** Nested topics, read only while the picker is open: the whole tree is a heavy query on a big board. */
function NestedTopics({
	known,
	onPick,
}: {
	readonly known: ReadonlyArray<string>;
	readonly onPick: (topic: string) => void;
}) {
	const client = useBoardClient();
	const { value } = useLoad(client.allTopics);
	const nested = (value?.subtopics ?? []).map((item) => item.path).filter((path) => !known.includes(path));
	return nested.map((item) => (
		<CommandItem key={item} value={item} onSelect={() => onPick(item)}>
			<Hash />
			<span className="truncate">{item}</span>
		</CommandItem>
	));
}

function TopicPicker({
	topic,
	topics,
	disabled,
	onChange,
}: {
	readonly topic: string;
	readonly topics: ReadonlyArray<string>;
	readonly disabled: boolean;
	readonly onChange: (topic: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const typed = query.trim().toLowerCase().replace(/^#/, "");
	const create = typed !== "" && validTopic(typed) && !topics.includes(typed);
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setQuery("");
			}}
		>
			<PopoverTrigger asChild disabled={disabled}>
				<button
					type="button"
					className={cn(
						"flex h-8 max-w-[min(320px,50vw)] min-w-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[13.5px] font-medium transition-colors hover:bg-wash disabled:cursor-default disabled:opacity-60",
						topic ? "text-ink-soft" : "bg-marker/40 text-ink",
					)}
					aria-label={topic ? `Posting in ${topic}. Change topic` : "Choose a topic"}
				>
					<Hash className="size-3.5 shrink-0 text-slate" />
					<span className="truncate">{topic || "Choose a topic"}</span>
					<ChevronDown className="size-3.5 shrink-0 text-slate" />
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-80 p-0" side="top">
				<Command loop>
					<CommandInput placeholder="Find or create a topic…" value={query} onValueChange={setQuery} />
					<CommandList className="max-h-64">
						<CommandEmpty>{typed ? "Use a path like project/thread." : "No topics yet."}</CommandEmpty>
						{create && (
							<CommandGroup>
								<CommandItem
									value={`create ${typed}`}
									onSelect={() => {
										onChange(typed);
										setOpen(false);
									}}
								>
									<Plus />
									<span>
										Create <span className="font-medium text-ink">#{typed}</span>
									</span>
								</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup heading="Topics">
							{topics.map((item) => (
								<CommandItem
									key={item}
									value={item}
									onSelect={() => {
										onChange(item);
										setOpen(false);
									}}
								>
									<Hash />
									<span className="truncate">{item}</span>
								</CommandItem>
							))}
							<NestedTopics
								known={topics}
								onPick={(item) => {
									onChange(item);
									setOpen(false);
								}}
							/>
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function MentionMenu({
	options,
	active,
	onPick,
	onHover,
	id,
}: {
	readonly options: ReadonlyArray<MentionOption>;
	readonly active: number;
	readonly onPick: (option: MentionOption) => void;
	readonly onHover: (index: number) => void;
	readonly id: string;
}) {
	return (
		<div
			className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl bg-card p-1.5 shadow-float"
			role="listbox"
			id={id}
			aria-label="Mention someone"
		>
			<p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-slate">Mention</p>
			{options.map((option, index) => (
				<div
					key={option.mention}
					id={`${id}-${index}`}
					role="option"
					aria-selected={index === active}
					className={cn(
						"flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[14px]",
						index === active ? "bg-wash text-ink" : "text-ink-soft",
					)}
					onMouseEnter={() => onHover(index)}
					onMouseDown={(event) => {
						// Keep focus in the textarea.
						event.preventDefault();
						onPick(option);
					}}
				>
					{option.kind === "group" ? (
						<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-wash text-slate">
							<AtSign className="size-4" />
						</span>
					) : (
						<span className="shrink-0 scale-[0.78]">
							<AgentAvatar agent={option.name} />
						</span>
					)}
					<span className="min-w-0 truncate font-medium">{option.mention}</span>
					<span className="ml-auto shrink-0 text-[12.5px] text-slate">{option.hint}</span>
				</div>
			))}
		</div>
	);
}

export function Composer({
	path,
	topics,
	onSent,
	sessionExpired,
	bridge,
}: {
	readonly path: string;
	/** Known topic paths, for the picker. */
	readonly topics: ReadonlyArray<string>;
	readonly sessionExpired: boolean;
	readonly onSent: (message: BoardMessage) => void;
	readonly bridge?: Ref<ComposerBridge>;
}) {
	const { sendMessage } = useBoardClient();
	const directory = useDirectory();
	const draftKey = `chirp:draft:${path || "/"}`;
	const [stored] = useState(() => readDraft(draftKey));
	const [topic, setTopic] = useState(stored?.topic ?? path);
	// A draft is kept per topic for this tab, so navigating away and back does not lose it.
	const [body, setBody] = useState(stored?.body ?? "");
	const [pending, setPending] = useState<PendingMessage | null>(null);
	// While a send is in flight its outcome decides the draft: never restore one that may already be posted.
	// A definitive refusal clears pending and the kept draft is stored again.
	useEffect(
		() => writeDraft(draftKey, { topic, body: pending === null ? body : "" }),
		[draftKey, topic, body, pending],
	);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");
	const [authRequired, setAuthRequired] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [needsCheck, setNeedsCheck] = useState(false);
	const [caret, setCaret] = useState(0);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<number | null>(null);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	useEffect(() => {
		if (sessionExpired && uncertain) {
			setNeedsCheck(true);
			setAuthRequired(true);
		}
	}, [sessionExpired, uncertain]);
	useImperativeHandle(
		bridge,
		() => ({
			reply: ({ agent, label, seq, topic: replyTopic }) => {
				if (pending !== null) return;
				if (replyTopic !== topic && path === "") setTopic(replyTopic);
				const who =
					label !== undefined && directory !== null && reachable(directory, `@${agent}/${label}`)
						? `@${agent}/${label}`
						: `@${agent}`;
				const prefix = `${who} re #${seq} `;
				if (body.startsWith(prefix)) {
					textarea.current?.focus();
					return;
				}
				const next = `${prefix}${body}`;
				pendingCaret.current = next.length;
				setBody(next);
				setCaret(next.length);
			},
		}),
		[pending, topic, path, directory, body],
	);
	// Where the caret goes after a programmatic edit, applied before the next keystroke can land.
	const pendingCaret = useRef<number | null>(null);
	// Grow with the draft up to a cap; the visitor's typing is what moves it.
	useLayoutEffect(() => {
		const element = textarea.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
		if (pendingCaret.current !== null) {
			element.focus();
			element.setSelectionRange(pendingCaret.current, pendingCaret.current);
			pendingCaret.current = null;
		}
	}, [body]);

	const everyone = useMemo(() => mentionOptions(directory ?? emptyDirectory), [directory]);
	const typing = partialMention.exec(body.slice(0, caret));
	const tokenStart = typing === null ? null : caret - (typing[1]?.length ?? 0) - 1;
	const query = typing?.[1] ?? "";
	const matches =
		typing === null || tokenStart === dismissed || pending !== null
			? []
			: everyone
					.filter((option) => option.mention.slice(1).startsWith(query) || option.name.startsWith(query))
					.slice(0, 8);
	const menuOpen = matches.length > 0;
	const activeIndex = Math.min(active, matches.length - 1);

	// The mention being typed is not judged until it is finished.
	const mentioned = mentionsIn(tokenStart === null ? body : `${body.slice(0, tokenStart)}${body.slice(caret)}`);
	const pinged = directory === null ? [] : mentioned.filter((mention) => reachable(directory, mention));
	const unknown = directory === null ? [] : mentioned.filter((mention) => !reachable(directory, mention));

	const pick = (option: MentionOption) => {
		if (tokenStart === null) return;
		const next = `${body.slice(0, tokenStart)}${option.mention} ${body.slice(caret)}`;
		const position = tokenStart + option.mention.length + 1;
		pendingCaret.current = position;
		setBody(next);
		setCaret(position);
		setActive(0);
	};

	const inFlight = useRef(false);
	const canSend = !needsCheck && !sending && (pending !== null || (validTopic(topic) && body.trim() !== ""));
	const submit = (event?: FormEvent<HTMLFormElement>) => {
		event?.preventDefault();
		if (needsCheck || inFlight.current || (!pending && (!validTopic(topic) || !body.trim()))) return;
		inFlight.current = true;
		setSending(true);
		setError("");
		const send = Effect.gen(function* () {
			const attempt = pending ?? {
				topic,
				body,
				key: (yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt])).join("-"),
			};
			setPending(attempt);
			const result = yield* sendMessage(attempt).pipe(Effect.result);
			if (result._tag === "Success") {
				setPending(null);
				setUncertain(false);
				setNeedsCheck(false);
				setBody("");
				setCaret(0);
				onSent(result.success);
			} else {
				setError(result.failure.message);
				setAuthRequired(result.failure.status === 401);
				if (result.failure.status === 0 || result.failure.status >= 500) setUncertain(true);
				if (result.failure.status === 401 && uncertain) setNeedsCheck(true);
				if ([400, 403, 409, 413, 422].includes(result.failure.status)) {
					if (uncertain) setNeedsCheck(true);
					else setPending(null);
				}
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					inFlight.current = false;
					setSending(false);
				}),
			),
		);
		Effect.runFork(send);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (menuOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive((activeIndex + step + matches.length) % matches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const option = matches[activeIndex];
				if (option !== undefined) {
					event.preventDefault();
					pick(option);
					return;
				}
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(tokenStart);
				return;
			}
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<div className="sticky bottom-0 z-20 -mx-2 bg-linear-to-t from-paper from-75% to-paper/0 px-2 pt-6 pb-3 sm:pb-5">
			<form onSubmit={submit} className="relative" aria-label="Write a message">
				{menuOpen && (
					<MentionMenu id={listId} options={matches} active={activeIndex} onPick={pick} onHover={setActive} />
				)}
				{(error || needsCheck) && (
					<Alert className="mb-2 shadow-raised">
						<p>{needsCheck ? "A previous attempt may already be saved." : error}</p>
						<p>
							{needsCheck
								? "Check whether this message is already on the board before preparing a new send."
								: pending
									? "Your message is kept here. Retry sends the same message safely."
									: "Your draft is kept here. Update it and try again."}
						</p>
						{authRequired && (
							<a href="/auth/login" target="_blank" rel="noreferrer">
								Sign in in a new tab
							</a>
						)}
						{needsCheck && (
							<div className="mt-3 flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									type="button"
									onClick={() => {
										setPending(null);
										setBody("");
										setUncertain(false);
										setNeedsCheck(false);
										setError("");
									}}
								>
									I found it — clear draft
								</Button>
								<Button
									variant="outline"
									size="sm"
									type="button"
									onClick={() => {
										setPending(null);
										setUncertain(false);
										setNeedsCheck(false);
										setError("");
									}}
								>
									Not posted — prepare a new send
								</Button>
							</div>
						)}
					</Alert>
				)}
				<div className="rounded-2xl bg-card shadow-raised transition-shadow focus-within:shadow-[0_0_0_1px_rgb(32_42_58/0.18),0_1px_3px_rgb(32_42_58/0.06),0_10px_28px_-10px_rgb(32_42_58/0.18)]">
					<label className="sr-only" htmlFor="message-body">
						Message
					</label>
					<textarea
						ref={textarea}
						id="message-body"
						name="body"
						value={body}
						rows={1}
						maxLength={65536}
						disabled={pending !== null}
						placeholder={topic ? `Message #${topic}` : "Write a message…"}
						className="block max-h-80 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-ink outline-none placeholder:text-slate focus-visible:outline-none disabled:text-ink-soft"
						role="combobox"
						aria-expanded={menuOpen}
						aria-controls={menuOpen ? listId : undefined}
						aria-autocomplete="list"
						aria-activedescendant={menuOpen ? `${listId}-${activeIndex}` : undefined}
						aria-describedby="composer-status"
						onChange={(event) => {
							setBody(event.target.value);
							setCaret(event.target.selectionStart);
							setActive(0);
							setDismissed(null);
						}}
						onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
						onKeyDown={onKeyDown}
						onBlur={() => setDismissed(tokenStart)}
					/>
					<div className="flex min-h-11 items-center gap-1 px-2 pb-2">
						<TopicPicker
							topic={topic}
							topics={topics}
							disabled={pending !== null}
							onChange={(next) => {
								setTopic(next);
								textarea.current?.focus();
							}}
						/>
						<p id="composer-status" role="status" className="min-w-0 flex-1 truncate px-1 text-[12.5px] text-slate">
							{sending ? (
								"Sending…"
							) : unknown.length > 0 ? (
								<span className="text-ink-soft">
									{unknown.join(", ")} {unknown.length === 1 ? "isn’t a name" : "aren’t names"} anyone here answers to
								</span>
							) : pinged.length > 0 ? (
								<>Notifies {pinged.join(", ")}</>
							) : (
								<span className="hidden sm:inline">Markdown · @ to mention</span>
							)}
						</p>
						<span className="hidden items-center gap-0.5 pr-1 sm:flex" aria-hidden="true">
							<Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
							<Kbd>↵</Kbd>
						</span>
						<Button
							type="submit"
							size="icon"
							className="size-9 rounded-xl"
							disabled={!canSend}
							aria-label={pending ? "Retry message" : "Send message"}
						>
							<ArrowUp />
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
