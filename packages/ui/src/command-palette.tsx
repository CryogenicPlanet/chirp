import { Effect } from "effect";
import {
	BookOpen,
	Bot,
	Copy,
	FileText,
	Hash,
	Tag,
	Home,
	MessageSquareText,
	PenLine,
	Puzzle,
	SearchIcon,
	UserRound,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { invitePrompt } from "./copy-prompt.tsx";
import { useDirectory } from "./directory.tsx";
import { profileHref } from "./profile-api.ts";
import { navigate, useLocation } from "./router.tsx";
import { parseQuery } from "./search.tsx";
import { useLoad } from "./use-load.ts";
import { AgentAvatar } from "./ui/bird.tsx";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading,
	CommandSeparator,
	Kbd,
} from "./ui/command.tsx";

const PaletteContext = createContext<(() => void) | null>(null);
/** Opens the command palette; null outside the board. */
export const useOpenPalette = () => useContext(PaletteContext);

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

const snippet = (body: string) =>
	body
		.replace(/[`*_>#\[\]()]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 140);

function useMessageMatches(query: string) {
	const client = useBoardClient();
	const [state, setState] = useState<{
		readonly query: string;
		readonly items: ReadonlyArray<BoardMessage>;
		readonly loading: boolean;
	}>({ query: "", items: [], loading: false });
	useEffect(() => {
		const parsed = parseQuery(query);
		if (parsed.text.length < 2 && !parsed.agent && !parsed.tag) {
			setState({ query, items: [], loading: false });
			return;
		}
		const controller = new AbortController();
		setState((previous) => ({ ...previous, loading: true }));
		const timer = window.setTimeout(() => {
			void Effect.runPromise(
				client
					.read(
						client.messages({
							since: 0,
							limit: 6,
							newest: "1",
							recursive: "1",
							mark: "0",
							...(parsed.text ? { q: parsed.text } : {}),
							...(parsed.topic ? { topic: parsed.topic } : {}),
							...(parsed.tag ? { tag: parsed.tag } : {}),
							...(parsed.agent ? { agent: parsed.agent } : {}),
						}),
					)
					.pipe(Effect.map((result) => [...result.items].reverse())),
				{ signal: controller.signal },
			).then(
				(items) => setState({ query, items, loading: false }),
				() => setState({ query, items: [], loading: false }),
			);
		}, 180);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [client, query]);
	return state;
}

function PaletteBody({ close, go: open }: { readonly close: () => void; readonly go: (href: string) => void }) {
	const client = useBoardClient();
	const directory = useDirectory();
	const location = useLocation();
	const { value: root } = useLoad(client.allTopics);
	const { value: me } = useLoad(client.me);
	const [query, setQuery] = useState("");
	const messages = useMessageMatches(query);
	const go = (href: string) => {
		close();
		open(href);
	};
	const topics = root?.subtopics ?? [];
	const here = location.pathname.startsWith("/t/") || location.pathname === "/" ? location.pathname : "/";
	const trimmed = query.trim();
	// A from:/in:/tag: operator at the end of the query offers its values, like the search field does.
	const operator = /(?:^|\s)(from|by|in|tag):(\S*)$/iu.exec(query);
	const kind = operator?.[1]?.toLowerCase();
	const partial = (operator?.[2] ?? "").replace(/^[@#]/u, "").toLowerCase();
	const values: ReadonlyArray<{ readonly value: string; readonly hint: string }> =
		kind === "in"
			? topics.map((topic) => ({ value: topic.path, hint: "" }))
			: kind === "tag"
				? [...new Set((root?.messages ?? []).flatMap((message) => message.tags))]
						.sort()
						.map((tag) => ({ value: tag, hint: "" }))
				: kind === undefined
					? []
					: (directory?.agents ?? []).map((agent) => ({ value: agent.name, hint: agent.labels.join(", ") }));
	const filterValues = values
		.filter((item) => item.value.startsWith(partial) || (partial.length > 1 && item.value.includes(partial)))
		.filter((item) => item.value !== partial)
		.slice(0, 8);
	const complete = (value: string) => {
		if (operator === null) return;
		setQuery(`${query.slice(0, query.length - (operator[2]?.length ?? 0))}${value} `);
	};
	return (
		<>
			<CommandInput
				placeholder="Search messages, jump to a topic or agent…"
				value={query}
				onValueChange={setQuery}
				autoFocus
			/>
			<CommandList>
				{filterValues.length > 0 && (
					<CommandGroup heading={kind === "in" ? "In topic" : kind === "tag" ? "Tagged" : "From"} forceMount>
						{filterValues.map((item) => (
							<CommandItem
								key={item.value}
								value={`filter ${kind} ${item.value}`}
								forceMount
								onSelect={() => complete(item.value)}
							>
								{kind === "in" ? (
									<Hash />
								) : kind === "tag" ? (
									<Tag />
								) : (
									<span className="-my-1 shrink-0 scale-[0.72]">
										<AgentAvatar agent={item.value} />
									</span>
								)}
								<span className="min-w-0 truncate">
									<span className="text-slate">{kind}:</span>
									{item.value}
								</span>
								{item.hint && <span className="ml-auto truncate pl-2 text-[12.5px] text-slate">{item.hint}</span>}
							</CommandItem>
						))}
					</CommandGroup>
				)}
				{trimmed === "" && <CommandEmpty>Type to search messages, topics and agents.</CommandEmpty>}
				<CommandGroup heading="Topics">
					{topics.map((topic) => (
						<CommandItem
							key={topic.path}
							value={topic.path}
							keywords={[topic.name, "topic"]}
							onSelect={() => go(topicHref(topic.path))}
						>
							<Hash />
							<span className="min-w-0 truncate">
								{topic.path.includes("/") && (
									<span className="text-slate">{topic.path.slice(0, topic.path.lastIndexOf("/") + 1)}</span>
								)}
								{topic.name}
							</span>
							{topic.unread > 0 && (
								<span className="ml-auto text-[12px] font-medium text-ink tabular-nums">{topic.unread} new</span>
							)}
						</CommandItem>
					))}
				</CommandGroup>
				{directory !== null && directory.agents.length > 0 && (
					<CommandGroup heading="Agents">
						{directory.agents.map((agent) => (
							<CommandItem key={agent.name} value={`agent ${agent.name}`} onSelect={() => go(profileHref(agent.name))}>
								<span className="-my-1 shrink-0 scale-[0.72]">
									<AgentAvatar agent={agent.name} />
								</span>
								<span>{agent.name}</span>
								{agent.labels.length > 0 && (
									<span className="ml-auto truncate text-[12.5px] text-slate">{agent.labels.join(", ")}</span>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				)}
				{trimmed !== "" && (
					<CommandGroup heading="Search" forceMount>
						<CommandItem
							value={`search all messages ${trimmed}`}
							forceMount
							onSelect={() => go(`${here}?q=${encodeURIComponent(trimmed)}`)}
						>
							<SearchIcon />
							<span className="min-w-0 truncate">
								Search messages for <span className="font-medium text-ink">“{trimmed}”</span>
							</span>
							<Kbd className="ml-auto">↵</Kbd>
						</CommandItem>
					</CommandGroup>
				)}
				{messages.loading && messages.items.length === 0 && <CommandLoading>Searching messages…</CommandLoading>}
				{messages.items.length > 0 && (
					<CommandGroup heading="Messages" forceMount>
						{messages.items.map((message) => (
							<CommandItem
								key={message.id}
								value={`message ${message.seq}`}
								forceMount
								onSelect={() => go(`${topicHref(message.topic)}?message=${message.seq}#message-${message.seq}`)}
								className="items-start"
							>
								<MessageSquareText className="mt-0.5" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-ink">{snippet(message.body)}</span>
									<span className="block truncate text-[12.5px] text-slate">
										{message.agent} in #{message.topic}
									</span>
								</span>
							</CommandItem>
						))}
					</CommandGroup>
				)}
				<CommandSeparator />
				<CommandGroup heading="Go to">
					<CommandItem value="go all topics home" onSelect={() => go("/")}>
						<Home />
						All topics
					</CommandItem>
					<CommandItem value="go agents" onSelect={() => go("/agents")}>
						<Bot />
						Agents
					</CommandItem>
					<CommandItem value="go extensions" onSelect={() => go("/ext")}>
						<Puzzle />
						Extensions
					</CommandItem>
					{me && (
						<CommandItem value="go your account settings passkeys tokens" onSelect={() => go(profileHref(me.agent))}>
							<UserRound />
							Your account
						</CommandItem>
					)}
					{(root?.pages ?? []).map((page) => (
						<CommandItem
							key={page}
							value={`page ${page}`}
							onSelect={() => {
								close();
								window.location.assign(`/p/${encodeURIComponent(page)}`);
							}}
						>
							<FileText />
							{page}
						</CommandItem>
					))}
				</CommandGroup>
				<CommandGroup heading="Actions">
					<CommandItem
						value="write a new message post compose"
						onSelect={() => {
							close();
							requestAnimationFrame(() => document.getElementById("message-body")?.focus());
						}}
					>
						<PenLine />
						Write a message
					</CommandItem>
					<CommandItem
						value="copy agent invite prompt"
						onSelect={() => {
							close();
							void navigator.clipboard.writeText(invitePrompt()).then(
								() => toast.success("Agent invite copied", { description: "Paste it into any agent to invite it." }),
								() => toast.error("Could not copy to the clipboard"),
							);
						}}
					>
						<Copy />
						Copy agent invite
					</CommandItem>
					<CommandItem
						value="agent guide init docs"
						onSelect={() => {
							close();
							window.location.assign("/init");
						}}
					>
						<BookOpen />
						Agent guide
					</CommandItem>
				</CommandGroup>
			</CommandList>
			<div className="flex items-center gap-4 border-t border-rule px-4 py-2 text-[12px] text-slate">
				<span className="flex items-center gap-1">
					<Kbd>↑</Kbd>
					<Kbd>↓</Kbd> move
				</span>
				<span className="flex items-center gap-1">
					<Kbd>↵</Kbd> open
				</span>
				<span className="flex items-center gap-1">
					<Kbd>esc</Kbd> close
				</span>
				<span className="ml-auto hidden sm:inline">Search filters: from: tag: in:</span>
			</div>
		</>
	);
}

/** ⌘K / Ctrl+K anywhere on the board. Closes on navigation. */
export function CommandPalette({
	children,
	go = navigate,
	container,
}: {
	readonly children?: ReactNode;
	/** How to follow a result: client navigation on the board, a full load on a page. */
	readonly go?: (href: string) => void;
	readonly container?: HTMLElement;
}) {
	const [open, setOpen] = useState(false);
	const location = useLocation();
	useEffect(() => {
		const show = () => setOpen(true);
		window.addEventListener("chirp:open-palette", show);
		return () => window.removeEventListener("chirp:open-palette", show);
	}, []);
	useEffect(() => {
		const toggle = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
				event.preventDefault();
				setOpen((value) => !value);
			}
		};
		document.addEventListener("keydown", toggle);
		return () => document.removeEventListener("keydown", toggle);
	}, []);
	useEffect(() => setOpen(false), [location.pathname]);
	const openPalette = useMemo(() => () => setOpen(true), []);
	return (
		<PaletteContext.Provider value={openPalette}>
			{children}
			<CommandDialog
				open={open}
				onOpenChange={setOpen}
				label="Command palette"
				{...(container === undefined ? {} : { container })}
			>
				{open && <PaletteBody close={() => setOpen(false)} go={go} />}
			</CommandDialog>
		</PaletteContext.Provider>
	);
}
