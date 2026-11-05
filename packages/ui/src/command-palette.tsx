import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { accountRequest } from "./account-api.ts";
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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { RegistryContext } from "@effect/atom-react";
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

const DirectoryListing = Schema.Struct({
	items: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
});
const pageLimit = 3000;

/**
 * Every page path on the board, from boot's file listing (filesystem work, outside the database read budget).
 * Walks folders breadth-first, many at a time, reporting each level as it lands so the shallow pages most people
 * look for show up within a second or two. Stops at a cap so a huge board stays responsive.
 */
const listPages = (onLevel: (pages: ReadonlyArray<string>) => void) =>
	Effect.gen(function* () {
		const found: Array<string> = [];
		const listFolder = (folder: string) =>
			accountRequest(
				HttpClientRequest.get(
					new URL(
						`/api/fs/pages${folder ? `/${folder.split("/").map(encodeURIComponent).join("/")}` : ""}`,
						window.location.origin,
					).href,
				),
			).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(DirectoryListing)),
				Effect.map((listing) => listing.items),
				Effect.orElseSucceed(() => []),
			);
		let level: ReadonlyArray<string> = [""];
		while (level.length > 0 && found.length < pageLimit) {
			const listings = yield* Effect.forEach(
				level,
				(folder) => listFolder(folder).pipe(Effect.map((items) => ({ folder, items }))),
				{ concurrency: 12 },
			);
			const next: Array<string> = [];
			for (const { folder, items } of listings)
				for (const item of items) {
					if (item.name.startsWith(".")) continue;
					const path = folder ? `${folder}/${item.name}` : item.name;
					if (item.type === "directory") next.push(path);
					else if (/\.(md|html?)$/i.test(item.name)) found.push(path);
				}
			onLevel([...found].sort());
			level = next;
		}
		return found.slice(0, pageLimit).sort();
	});

// The page list is kept for a few minutes per browser tab, so moving between pages does not walk the tree again.
const pageCacheKey = "chirp:page-index";
const pageCacheAge = 5 * 60_000;
const cachedPages = (): ReadonlyArray<string> | null => {
	try {
		const raw = window.sessionStorage.getItem(pageCacheKey);
		if (raw === null) return null;
		const decoded = Schema.decodeUnknownOption(
			Schema.Struct({ at: Schema.Finite, pages: Schema.Array(Schema.String) }),
		)(JSON.parse(raw));
		return decoded._tag === "Some" && Date.now() - decoded.value.at < pageCacheAge ? decoded.value.pages : null;
	} catch {
		return null;
	}
};
const cachePages = (pages: ReadonlyArray<string>) => {
	try {
		window.sessionStorage.setItem(pageCacheKey, JSON.stringify({ at: Date.now(), pages }));
	} catch {
		// Storage can be unavailable (private windows); the index just loads again next time.
	}
};

const PaletteContext = createContext<(() => void) | null>(null);
/** Opens the command palette; null outside the board. */
export const useOpenPalette = () => useContext(PaletteContext);

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

const snippet = (body: string) =>
	body
		.replace(/[`*_>#[\]()]/g, "")
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
				(items) => {
					if (!controller.signal.aborted) setState({ query, items, loading: false });
				},
				() => {
					if (!controller.signal.aborted) setState({ query, items: [], loading: false });
				},
			);
		}, 180);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [client, query]);
	return state;
}

function PaletteBody({
	close,
	go: open,
	pages,
	pagesDone,
}: {
	readonly close: () => void;
	readonly go: (href: string) => void;
	readonly pages: ReadonlyArray<string> | null;
	readonly pagesDone: boolean;
}) {
	const client = useBoardClient();
	const directory = useDirectory();
	const { value: root } = useLoad(client.allTopics);
	const { value: me } = useLoad(client.me);
	const [query, setQuery] = useState("");
	const messages = useMessageMatches(query);
	const go = (href: string) => {
		close();
		open(href);
	};
	const topics = root?.subtopics ?? [];
	const trimmed = query.trim();
	// Pages are filtered and capped here rather than by cmdk, which would score every indexed page per keystroke.
	const pageMatches = useMemo(() => {
		const words = parseQuery(trimmed).text.toLowerCase().split(/\s+/u).filter(Boolean);
		if (pages === null || words.length === 0) return [];
		const scored = pages
			.map((page) => {
				const lower = page.toLowerCase();
				const file = lower.slice(lower.lastIndexOf("/") + 1);
				return words.every((word) => lower.includes(word))
					? { page, score: words.filter((word) => file.includes(word)).length * 10 - page.length / 100 }
					: null;
			})
			.filter((match) => match !== null);
		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((match) => match.page);
	}, [pages, trimmed]);
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
				placeholder="Search topics, pages and messages…"
				value={query}
				onValueChange={setQuery}
				autoFocus
				trailing={
					<button
						type="button"
						onClick={close}
						className="shrink-0 cursor-pointer py-2 text-[14.5px] font-medium text-ink-soft hover:text-ink sm:hidden"
					>
						Cancel
					</button>
				}
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
				{trimmed !== "" && !pagesDone && <CommandLoading>Finding pages…</CommandLoading>}
				{pageMatches.length > 0 && (
					<CommandGroup heading="Pages" forceMount>
						{pageMatches.map((page) => (
							<CommandItem
								forceMount
								key={page}
								value={`/p/${page}`}
								keywords={[
									page
										.split("/")
										.at(-1)
										?.replace(/\.(md|html?)$/i, "") ?? page,
								]}
								onSelect={() => {
									close();
									window.location.assign(`/p/${page.split("/").map(encodeURIComponent).join("/")}`);
								}}
							>
								<FileText />
								<span className="min-w-0 truncate">
									{page.includes("/") && <span className="text-slate">{page.slice(0, page.lastIndexOf("/") + 1)}</span>}
									{page.slice(page.lastIndexOf("/") + 1)}
								</span>
							</CommandItem>
						))}
					</CommandGroup>
				)}
				{trimmed !== "" && (
					<CommandGroup heading="Search" forceMount>
						<CommandItem
							value={`search all messages ${trimmed}`}
							forceMount
							onSelect={() => go(`/search?q=${encodeURIComponent(trimmed)}`)}
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
				</CommandGroup>
				<CommandGroup heading="Actions">
					<CommandItem
						value="write a new message post compose"
						onSelect={() => {
							close();
							const composer = document.getElementById("message-body");
							// Pages have no composer: open the board's.
							if (composer === null) open("/");
							else requestAnimationFrame(() => composer.focus());
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
			<div className="hidden shrink-0 items-center gap-4 border-t border-rule px-4 py-2 text-[12px] text-slate sm:flex">
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
	const [pages, setPages] = useState<ReadonlyArray<string> | null>(cachedPages);
	const [pagesDone, setPagesDone] = useState(() => cachedPages() !== null);
	// Warm the topic list once the board has settled, so ⌘K opens with topics already there.
	const client = useBoardClient();
	const registry = useContext(RegistryContext);
	useEffect(() => {
		const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
		let release = () => {};
		const timer = window.setTimeout(() => idle(() => (release = registry.mount(client.allTopics))), 4_000);
		return () => {
			window.clearTimeout(timer);
			release();
		};
	}, [client, registry]);
	// Index pages when the palette first opens, or once the page has been idle a few seconds.
	const indexing = useRef(false);
	const startIndex = useCallback(() => {
		if (indexing.current || pagesDone) return;
		indexing.current = true;
		void Effect.runPromise(listPages(setPages)).then(
			(all) => {
				setPages(all);
				setPagesDone(true);
				cachePages(all);
			},
			() => setPagesDone(true),
		);
	}, [pagesDone]);
	useEffect(() => {
		if (open) startIndex();
	}, [open, startIndex]);
	useEffect(() => {
		const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 1));
		const timer = window.setTimeout(() => idle(startIndex), 3_000);
		return () => window.clearTimeout(timer);
	}, [startIndex]);
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
		// Capture phase on window: pages that handle keys themselves (decks, editors) can't swallow ⌘K first.
		window.addEventListener("keydown", toggle, { capture: true });
		return () => window.removeEventListener("keydown", toggle, { capture: true });
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
				{open && <PaletteBody close={() => setOpen(false)} go={go} pages={pages} pagesDone={pagesDone} />}
			</CommandDialog>
		</PaletteContext.Provider>
	);
}
