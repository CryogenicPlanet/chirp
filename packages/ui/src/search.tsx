import { Effect } from "effect";
import { Hash, LoaderCircle, SearchIcon, Tag, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { validTopic, type BoardMessage } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { cn } from "./cn.ts";
import { useDirectory } from "./directory.tsx";
import { useLoad } from "./use-load.ts";
import { AgentAvatar } from "./ui/bird.tsx";
import { MessageList } from "./message.tsx";
import { useLocation } from "./router.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/command.tsx";

const limit = 50;

/** `from:codex tag:review in:home "exact phrase" words` → server filters and the free text. */
export interface ParsedQuery {
	readonly text: string;
	readonly agent: string;
	readonly tag: string;
	readonly topic: string;
}

export const parseQuery = (input: string): ParsedQuery => {
	const filters = { agent: "", tag: "", topic: "" };
	const text = input
		.replace(/(?:^|\s)(from|by|tag|in):(\S+)/giu, (_match, key: string, value: string) => {
			const clean = value.replace(/^[@#]/u, "").toLowerCase();
			if (key.toLowerCase() === "tag") filters.tag = clean;
			else if (key.toLowerCase() === "in") filters.topic = clean;
			else filters.agent = clean;
			return " ";
		})
		// An operator still waiting for its value is not search text.
		.replace(/(?:^|\s)(?:from|by|tag|in):(?=\s|$)/giu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return { text, ...filters };
};

/** Highlight words and phrases, not operators. */
const termsOf = (text: string): ReadonlyArray<string> =>
	[...text.matchAll(/"([^"]+)"|(\S+)/gu)]
		.map((match) => (match[1] ?? match[2] ?? "").trim())
		.filter((term) => term.length > 1 && !/^(and|or|not)$/iu.test(term));

const hints = [
	{ token: "from:", label: "from:agent" },
	{ token: "tag:", label: "tag:name" },
	{ token: "in:", label: "in:topic" },
	{ token: '"', label: '"exact phrase"' },
];

const typingInField = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * One field searches as you type. Results replace the conversation until cleared; the query lives in ?q= so
 * it can be shared and the command palette can open it.
 */
export function Search({ path, onActive }: { readonly path: string; readonly onActive: (active: boolean) => void }) {
	const client = useBoardClient();
	const location = useLocation();
	const fromUrl = new URLSearchParams(location.search).get("q") ?? "";
	const [input, setInput] = useState(fromUrl);
	const [everywhere, setEverywhere] = useState(path === "");
	const [items, setItems] = useState<ReadonlyArray<BoardMessage>>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [searched, setSearched] = useState<ParsedQuery | null>(null);
	const field = useRef<HTMLInputElement>(null);
	const request = useRef<AbortController | null>(null);
	const directory = useDirectory();
	const { value: board } = useLoad(client.allTopics);
	const [caret, setCaret] = useState(0);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);
	const pendingCaret = useRef<number | null>(null);
	const listId = useId();
	useLayoutEffect(() => {
		if (pendingCaret.current === null) return;
		field.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = null;
	}, [input]);
	// The from:/in:/tag: operator being typed at the caret, and what it could become.
	const operator = /(?:^|\s)(from|by|in|tag):(\S*)$/iu.exec(input.slice(0, caret));
	const kind = operator?.[1]?.toLowerCase();
	const partial = (operator?.[2] ?? "").replace(/^[@#]/u, "").toLowerCase();
	const tags = useMemo(() => [...new Set((board?.messages ?? []).flatMap((message) => message.tags))].sort(), [board]);
	const choices: ReadonlyArray<{ readonly value: string; readonly hint: string }> =
		kind === "in"
			? (board?.subtopics ?? []).map((item) => ({ value: item.path, hint: item.unread ? `${item.unread} new` : "" }))
			: kind === "tag"
				? tags.map((tag) => ({ value: tag, hint: "" }))
				: kind === undefined
					? []
					: (directory?.agents ?? []).map((agent) => ({
							value: agent.name,
							hint: agent.labels.join(", "),
						}));
	const suggestions =
		operator === null || !focused || dismissed === `${kind}:${caret}`
			? []
			: choices
					.filter(
						(choice) => choice.value.startsWith(partial) || (partial.length > 1 && choice.value.includes(partial)),
					)
					.filter((choice) => choice.value !== partial)
					.slice(0, 8);
	const suggesting = suggestions.length > 0;
	const activeIndex = Math.min(active, suggestions.length - 1);
	const choose = (value: string) => {
		if (operator === null) return;
		const start = caret - (operator[2]?.length ?? 0);
		const next = `${input.slice(0, start)}${value} ${input.slice(caret).trimStart()}`;
		pendingCaret.current = start + value.length + 1;
		setInput(next);
		setCaret(start + value.length + 1);
		setActive(0);
	};

	useEffect(() => setInput(fromUrl), [fromUrl]);
	useEffect(() => {
		const focus = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typingInField(event.target)) return;
			event.preventDefault();
			field.current?.focus();
		};
		document.addEventListener("keydown", focus);
		return () => document.removeEventListener("keydown", focus);
	}, []);

	const query = parseQuery(input);
	const searching = input.trim() !== "";
	useEffect(() => onActive(searching), [searching, onActive]);
	useEffect(() => () => onActive(false), [onActive]);

	const scope = query.topic || (everywhere ? "" : path);
	useEffect(() => {
		request.current?.abort();
		const parsed = parseQuery(input);
		const within = parsed.topic || (everywhere ? "" : path);
		if (input.trim() === "") {
			setSearched(null);
			setItems([]);
			setError("");
			setLoading(false);
			return;
		}
		if (within && !validTopic(within)) {
			setError("in: needs a topic path, like in:home/renovation.");
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		setLoading(true);
		setError("");
		const timer = window.setTimeout(() => {
			const url = new URL(window.location.href);
			url.searchParams.set("q", input.trim());
			window.history.replaceState(window.history.state, "", url.href);
			void Effect.runPromise(
				client
					.read(
						client.messages({
							since: 0,
							limit,
							newest: "1",
							recursive: "1",
							mark: "0",
							...(parsed.text ? { q: parsed.text } : {}),
							...(within ? { topic: within } : {}),
							...(parsed.tag ? { tag: parsed.tag } : {}),
							...(parsed.agent ? { agent: parsed.agent } : {}),
						}),
					)
					.pipe(
						Effect.match({
							onSuccess: (result) => {
								setItems([...result.items].reverse());
								setSearched(parsed);
								setLoading(false);
							},
							onFailure: (failure) => {
								setError(failure.message);
								setLoading(false);
							},
						}),
					),
				{ signal: controller.signal },
			).catch(() => {});
		}, 220);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [client, input, everywhere, path]);

	const clear = () => {
		setInput("");
		const url = new URL(window.location.href);
		url.searchParams.delete("q");
		window.history.replaceState(window.history.state, "", url.href);
		field.current?.focus();
	};
	const removeFilter = (pattern: RegExp) =>
		setInput((value) => value.replace(pattern, " ").replace(/\s+/gu, " ").trimStart());
	const pills = [
		...(query.agent ? [{ key: "from", value: query.agent, pattern: /(?:^|\s)(?:from|by):\S+/giu }] : []),
		...(query.tag ? [{ key: "tag", value: query.tag, pattern: /(?:^|\s)tag:\S+/giu }] : []),
		...(query.topic ? [{ key: "in", value: query.topic, pattern: /(?:^|\s)in:\S+/giu }] : []),
	];

	return (
		<section className="mb-6" aria-label="Search messages">
			<div className="flex flex-wrap items-center gap-2">
				<div className="group relative min-w-0 flex-1 basis-72">
					<SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate" />
					<input
						ref={field}
						type="search"
						value={input}
						onChange={(event) => {
							setInput(event.target.value);
							setCaret(event.target.selectionStart ?? event.target.value.length);
							setActive(0);
							setDismissed(null);
						}}
						onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
						onKeyDown={(event) => {
							if (suggesting) {
								if (event.key === "ArrowDown" || event.key === "ArrowUp") {
									event.preventDefault();
									const step = event.key === "ArrowDown" ? 1 : -1;
									setActive((activeIndex + step + suggestions.length) % suggestions.length);
									return;
								}
								const choice = suggestions[activeIndex];
								if ((event.key === "Enter" || event.key === "Tab") && choice !== undefined) {
									event.preventDefault();
									choose(choice.value);
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setDismissed(`${kind}:${caret}`);
									return;
								}
							}
							if (event.key === "Escape") {
								if (input) clear();
								else event.currentTarget.blur();
							}
						}}
						role="combobox"
						aria-expanded={suggesting}
						aria-controls={suggesting ? listId : undefined}
						aria-autocomplete="list"
						aria-activedescendant={suggesting ? `${listId}-${activeIndex}` : undefined}
						maxLength={512}
						aria-label="Search messages"
						placeholder={everywhere || path === "" ? "Search all messages" : `Search #${path}`}
						className="h-11 w-full rounded-xl bg-card pr-20 pl-10 text-[15px] text-ink shadow-raised outline-none placeholder:text-slate focus-visible:shadow-[0_0_0_2px_var(--color-ink)] [&::-webkit-search-cancel-button]:hidden"
					/>
					<span className="absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center gap-1">
						{loading && <LoaderCircle className="size-4 animate-spin text-slate" aria-label="Searching" />}
						{input ? (
							<button
								type="button"
								onClick={clear}
								className="grid size-7 cursor-pointer place-items-center rounded-md text-slate hover:bg-wash hover:text-ink"
								aria-label="Clear search"
							>
								<X className="size-4" />
							</button>
						) : (
							<Kbd className="hidden sm:inline-flex sm:group-focus-within:hidden">/</Kbd>
						)}
					</span>
					{suggesting && (
						<div
							id={listId}
							role="listbox"
							aria-label={kind === "in" ? "Topics" : kind === "tag" ? "Tags" : "Agents"}
							className="absolute top-full left-0 z-30 mt-2 w-full max-w-sm overflow-hidden rounded-xl bg-card p-1.5 shadow-float"
						>
							<p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-slate">
								{kind === "in" ? "In topic" : kind === "tag" ? "Tagged" : "From"}
							</p>
							{suggestions.map((choice, index) => (
								<div
									key={choice.value}
									id={`${listId}-${index}`}
									role="option"
									aria-selected={index === activeIndex}
									onMouseEnter={() => setActive(index)}
									onMouseDown={(event) => {
										event.preventDefault();
										choose(choice.value);
									}}
									className={cn(
										"flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-[14px] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-slate",
										index === activeIndex ? "bg-wash text-ink" : "text-ink-soft",
									)}
								>
									{kind === "in" ? (
										<Hash />
									) : kind === "tag" ? (
										<Tag />
									) : (
										<span className="-my-1 shrink-0 scale-[0.7]">
											<AgentAvatar agent={choice.value} />
										</span>
									)}
									<span className="min-w-0 truncate font-medium">{choice.value}</span>
									{choice.hint && <span className="ml-auto truncate pl-2 text-[12.5px] text-slate">{choice.hint}</span>}
								</div>
							))}
						</div>
					)}
				</div>
				{path !== "" && (
					<div
						className="flex h-11 shrink-0 rounded-xl bg-wash p-1 ring-1 ring-rule"
						role="group"
						aria-label="Search scope"
					>
						{[
							{ label: "This topic", value: false },
							{ label: "Everywhere", value: true },
						].map((option) => (
							<button
								key={option.label}
								type="button"
								aria-pressed={everywhere === option.value}
								onClick={() => setEverywhere(option.value)}
								className={cn(
									"cursor-pointer rounded-lg px-3 text-[13.5px] font-medium transition-colors",
									everywhere === option.value ? "bg-card text-ink shadow-raised" : "text-slate hover:text-ink",
								)}
							>
								{option.label}
							</button>
						))}
					</div>
				)}
			</div>
			{(pills.length > 0 || !searching) && (
				<div
					className={cn(
						"mt-2.5 min-h-7 flex-wrap items-center gap-1.5 text-[12.5px] text-slate",
						pills.length > 0 ? "flex" : "hidden sm:flex",
					)}
				>
					{pills.map((pill) => (
						<span
							key={pill.key}
							className="inline-flex h-7 items-center gap-1 rounded-lg bg-marker/40 pr-1 pl-2.5 font-medium text-ink ring-1 ring-marker"
						>
							<span className="text-ink-soft">{pill.key}:</span>
							{pill.value}
							<button
								type="button"
								className="grid size-5 cursor-pointer place-items-center rounded-md hover:bg-marker"
								aria-label={`Remove ${pill.key} filter`}
								onClick={() => removeFilter(pill.pattern)}
							>
								<X className="size-3" />
							</button>
						</span>
					))}
					{!searching && (
						<>
							<span className="mr-0.5">Filter with</span>
							{hints.map((hint) => (
								<button
									key={hint.token}
									type="button"
									className="h-7 cursor-pointer rounded-lg bg-card px-2 font-mono text-[12px] text-ink-soft ring-1 ring-rule transition-colors hover:bg-wash hover:text-ink"
									onClick={() => {
										const next = `${input}${input && !input.endsWith(" ") ? " " : ""}${hint.token}`;
										pendingCaret.current = next.length;
										setInput(next);
										setCaret(next.length);
										setDismissed(null);
										field.current?.focus();
									}}
								>
									{hint.label}
								</button>
							))}
						</>
					)}
				</div>
			)}
			{searching && (
				<div className="mt-5" aria-label="Search results" aria-live="polite">
					<div className="mb-2 flex min-h-8 items-center justify-between gap-4 border-b border-rule pb-2 text-[13px] text-slate">
						<p role="status">
							{error
								? "Search failed"
								: searched === null
									? "Searching…"
									: items.length === 0
										? "No matches"
										: `${items.length === limit ? `Latest ${limit}` : items.length} ${items.length === 1 ? "match" : "matches"}${scope ? ` in #${scope}` : ""}, newest first`}
						</p>
						<Button variant="ghost" size="sm" type="button" onClick={clear}>
							Back to conversation
						</Button>
					</div>
					{error && <Alert className="mt-3">{error}</Alert>}
					{searched !== null && items.length === 0 && !error && (
						<p className="py-10 text-center text-[14px] text-slate">
							Nothing matches. Try fewer words{scope ? " or search everywhere" : ""}.
						</p>
					)}
					<div className={cn("transition-opacity", loading && "opacity-60")}>
						<MessageList messages={items} highlight={termsOf(searched?.text ?? "")} />
					</div>
					{items.length === limit && (
						<p className="pt-4 text-center text-[13px] text-slate">
							Showing the latest {limit}. Add from:, tag: or in: to narrow it down.
						</p>
					)}
				</div>
			)}
		</section>
	);
}
