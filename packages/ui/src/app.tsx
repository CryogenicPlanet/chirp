import { Onboarding, useFirstVisit } from "./onboarding.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { useVisible } from "./use-visible.ts";
import { Atom } from "effect/unstable/reactivity";
import { BoardClientProvider, useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Toaster } from "sonner";
import { topicHref, validTopic, type BoardMessage, type BoardTopic } from "./board-api.ts";
import { MessageList } from "./message.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { ComposerBridgeContext, type ComposerBridge } from "./composer-bridge.tsx";
import { DirectoryProvider } from "./directory.tsx";
import { TooltipProvider, Tooltip } from "./ui/tooltip.tsx";
import { Markdown } from "./markdown.tsx";
import { ReferencedMessage } from "./referenced-message.tsx";
import { Extensions } from "./extensions.tsx";
import { Agents } from "./agents.tsx";
import { Profile } from "./profile.tsx";
import { profileFromPath } from "./profile-api.ts";
import { Search } from "./search.tsx";
import { TopicSettings } from "./topic-controls.tsx";
import { useLoad } from "./use-load.ts";
import { useIntent } from "./use-intent.ts";
import { relativeTime } from "./time.ts";
import { boardChanged } from "./live-events.ts";
import { Composer, stashReply } from "./composer.tsx";
import { LoadProblem, useAutoRetry } from "./load-problem.tsx";
import { HistoryEdge } from "./history-edge.tsx";
import { hasTopicContext, TopicContextBar, TopicRail } from "./topic-context.tsx";
import { useOlderMessages } from "./older-messages.ts";
import { Link, navigate, useLocation, useScrollOnNavigate } from "./router.tsx";
import { Bot, FileText, Hash, Home, Puzzle, RefreshCw, Settings2 } from "lucide-react";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert } from "./ui/alert.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { PageHeader } from "./ui/page-header.tsx";
import { MessagesSkeleton } from "./ui/skeleton.tsx";
import { cn } from "./cn.ts";

const currentPath = (pathname: string) => {
	if (pathname === "/") return "";
	if (!pathname.startsWith("/t/")) return null;
	try {
		const path = decodeURIComponent(pathname.slice(3));
		return validTopic(path) ? path : null;
	} catch {
		return null;
	}
};

export function App() {
	const location = useLocation();
	useScrollOnNavigate();
	useFirstVisit(location.pathname);
	const agent = profileFromPath(location.pathname);
	/* No keyed remount here: the layout and loaded data stay put, only the routed view swaps. */
	if (location.pathname === "/onboarding") return <Onboarding />;
	return (
		<TooltipProvider delayDuration={300}>
			<BoardClientProvider>
				<DirectoryProvider>
					<CommandPalette>
						{location.pathname === "/ext" ? (
							<Extensions />
						) : location.pathname === "/agents" ? (
							<Agents />
						) : agent !== null ? (
							<Profile agent={agent} />
						) : (
							<Board pathname={location.pathname} search={location.search} hash={location.hash} />
						)}
					</CommandPalette>
				</DirectoryProvider>
			</BoardClientProvider>
			<Toaster
				position="bottom-center"
				toastOptions={{
					className: "!rounded-xl !bg-ink !text-white !border-0 !shadow-float !text-[14px]",
					descriptionClassName: "!text-white/75",
				}}
			/>
		</TooltipProvider>
	);
}

/** "claude: Got three quotes… · 2h" under a topic card. */
function LatestLine({ message }: { readonly message: BoardMessage | undefined }) {
	if (message === undefined) return null;
	const text = message.body
		.replace(/[`*_>#[\]()]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return (
		<span className="mt-0.5 flex min-w-0 gap-1 text-[13px] text-slate">
			<span className="shrink-0 font-medium text-ink-soft">{message.agent}:</span>
			<span className="min-w-0 truncate">{text}</span>
			<span className="shrink-0">· {relativeTime(message.created_at, Date.now())}</span>
		</span>
	);
}

/** A topic card that warms its topic when a click looks likely. */
function TopicCard({ path, ...props }: Parameters<typeof Link>[0] & { readonly path: string }) {
	const { prefetchTopic } = useBoardClient();
	const intent = useIntent(() => prefetchTopic(path));
	return <Link {...props} {...intent} />;
}

function TopicNav({
	path,
	topics,
}: {
	readonly path: string | null;
	readonly topics: ReadonlyArray<BoardTopic["subtopics"][number]>;
}) {
	const { prefetchTopic: prefetch } = useBoardClient();
	return (
		<>
			<NavLink href="/" active={path === ""}>
				<Home />
				All topics
			</NavLink>
			<NavLink href="/agents">
				<Bot />
				Agents
			</NavLink>
			<NavLink href="/ext">
				<Puzzle />
				Extensions
			</NavLink>
			<div className="mx-2.5 mt-6 mb-1 text-[12.5px] font-medium text-slate">Topics</div>
			{topics.map((item) => {
				const active = path === item.path || (path !== null && path.startsWith(`${item.path}/`));
				return (
					<NavLink
						href={topicHref(item.path)}
						key={item.path}
						active={active}
						onIntent={() => prefetch(item.path)}
						className={cn(item.unread > 0 && !active && "font-semibold text-ink")}
					>
						<Hash />
						<span className="min-w-0 truncate">{item.name}</span>
						{item.archived_at !== null && <span className="text-[12px] font-normal text-slate">archived</span>}
						{item.unread > 0 && (
							<Badge variant="count" className="ml-auto" title={`${item.unread} unread messages`}>
								{item.unread > 99 ? "99+" : item.unread}
							</Badge>
						)}
					</NavLink>
				);
			})}
			{topics.length === 0 && (
				<p className="px-2.5 text-[13px] leading-relaxed text-slate">Your first message starts a topic.</p>
			)}
		</>
	);
}

function Board({
	pathname,
	search,
	hash,
}: {
	readonly pathname: string;
	readonly search: string;
	readonly hash: string;
}) {
	const client = useBoardClient();
	const visible = useVisible();
	// /search is the board-wide search page: the board's data for the sidebar, only search in the page.
	const searchPage = pathname === "/search";
	const path = searchPage ? "" : currentPath(pathname);
	const [showArchived, setShowArchived] = useState(false);
	// Set once this route's topic has opened; older history loads and reads are marked only from then on.
	const [armedPath, setArmedPath] = useState<string | null>(null);
	const [searching, setSearching] = useState(() => new URLSearchParams(search).has("q"));
	const [settingsOpen, setSettingsOpen] = useState(false);
	const composer = useRef<ComposerBridge>(null);
	const bridge = useMemo<ComposerBridge>(
		() => ({
			reply: (reply) => {
				if (composer.current !== null) composer.current.reply(reply);
				else {
					// No composer here (the search page): start the reply as that topic's draft and open it.
					stashReply(reply);
					navigate(topicHref(reply.topic));
				}
			},
		}),
		[],
	);
	useEffect(() => {
		setSettingsOpen(false);
	}, [pathname]);
	const request = useMemo(() => {
		if (path === null) return Atom.make(Effect.succeed(null));
		const root = client.topic("", showArchived, visible && path === "" && !searching);
		// A topic first loads without marking (the same read a hover prefetch warms), so its unread position is
		// known; once it has opened (armed), the view re-reads with marking on.
		const topic =
			path === "" ? root : client.topic(path, showArchived, visible && !searching && armedPath === pathname);
		const read = Atom.make((get) =>
			Effect.all(
				{ root: get.result(root, { suspendOnWaiting: true }), topic: get.result(topic, { suspendOnWaiting: true }) },
				{ concurrency: "unbounded" },
			),
		);
		return Atom.readable(read.read, (refresh) => {
			refresh(root);
			if (topic !== root) refresh(topic);
		});
	}, [client, path, showArchived, searching, visible, armedPath, pathname]);
	const { value, error, loading, reload, update } = useLoad(request);
	// Live: re-read this view when the board changes (coalesced in live-events.ts), unless searching.
	useEffect(() => {
		if (searching) return;
		window.addEventListener(boardChanged, reload);
		return () => window.removeEventListener(boardChanged, reload);
	}, [reload, searching]);
	// A copy warmed on hover renders at once; the marking read replaces it when it lands.
	const peekRequest = useMemo(
		() => (path === null ? null : client.peekTopic(path)) ?? Atom.make(Effect.succeed(null)),
		[client, path],
	);
	const { value: peeked } = useLoad(peekRequest);
	const root = value?.root;
	const topic = value?.topic;
	const onSent = (message: BoardMessage) => {
		if (path === "" || path === message.topic)
			update(
				(previous) =>
					previous && {
						...previous,
						topic: {
							...previous.topic,
							messages: [...previous.topic.messages.filter((item) => item.id !== message.id), message]
								.sort((a, b) => a.seq - b.seq)
								.slice(-100),
						},
					},
			);
		reload();
		requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
	};
	// A topic opens at its latest message, like any chat; a linked message or search keeps its own position.
	// Wait for this route's own data (the previous route's stays visible while loading), and scroll after the
	// router's own scroll-to-top, which runs in the parent's effect.
	const fresh = topic !== undefined && path !== null && topic.path === path;
	// What this route shows: its own data only, never the previous route's while the new one loads.
	const view = fresh ? topic : peeked !== null && peeked !== undefined && peeked.path === path ? peeked : undefined;
	const retry = useAutoRetry(error, reload);
	const landed = useRef<string | null>(null);
	// Leaving a route (to another topic, the root or search) resets arrival, so coming back captures the unread
	// position again before marking. Declared before the landing effect so it runs first.
	useEffect(() => {
		landed.current = null;
		setArmedPath(null);
	}, [pathname]);
	const [firstUnread, setFirstUnread] = useState<{ readonly path: string; readonly seq: number } | null>(null);
	const messageCount = view?.messages.length ?? 0;
	useEffect(() => {
		if (view === undefined || path === "" || landed.current === pathname) return;
		if (hash !== "" || searching || messageCount === 0) {
			landed.current = pathname;
			setFirstUnread(null);
			setArmedPath(pathname);
			return;
		}
		// Unread messages in a leaf topic: mark where they start, and open there. (A topic's unread count also
		// includes its subtopics, so the position is only known for topics without them.)
		const unreadFrom =
			view.subtopics.length === 0 && view.unread > 0 && view.unread < view.messages.length
				? (view.messages[view.messages.length - view.unread]?.seq ?? null)
				: null;
		setFirstUnread(unreadFrom === null ? null : { path: pathname, seq: unreadFrom });
		// Recorded inside the frame: a refresh that re-runs this effect first cancels the frame, and the rerun
		// must still land.
		const frame = requestAnimationFrame(() => {
			landed.current = pathname;
			const divider = unreadFrom === null ? null : document.getElementById("unread-divider");
			if (divider !== null) divider.scrollIntoView({ block: "start" });
			else window.scrollTo(0, document.documentElement.scrollHeight);
			pinned.current = divider === null;
			setArmedPath(pathname);
		});
		return () => cancelAnimationFrame(frame);
	}, [view, pathname, path, hash, searching, messageCount]);
	// Stay pinned to the bottom when new messages arrive while reading the latest.
	const lastSeq = view?.messages.at(-1)?.seq ?? 0;
	const pinned = useRef(true);
	useEffect(() => {
		const track = () => {
			pinned.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
		};
		window.addEventListener("scroll", track, { passive: true });
		return () => window.removeEventListener("scroll", track);
	}, []);
	useLayoutEffect(() => {
		if (lastSeq !== 0 && pinned.current && landed.current === pathname && path !== "" && !searching && hash === "")
			window.scrollTo(0, document.documentElement.scrollHeight);
	}, [lastSeq, pathname, path, searching, hash]);

	// Older pages load as the top of the list scrolls into view, keeping the reader's place.
	const history = useOlderMessages(path, view?.messages[0]?.seq);
	// The view's snapshot is the latest 100. Messages that scroll out of it while the topic is open are kept,
	// so a busy topic never opens a gap between loaded history and the snapshot.
	const retained = useRef<{ readonly path: string; readonly messages: ReadonlyArray<BoardMessage> }>({
		path: "",
		messages: [],
	});
	const shownMessages = useMemo(() => {
		const latest = view?.messages ?? [];
		const first = latest[0]?.seq ?? Number.MAX_SAFE_INTEGER;
		const previous = retained.current.path === pathname ? retained.current.messages : [];
		// Only a full snapshot can have pushed messages out; a shorter one holds everything, so anything missing
		// from it was deleted, not displaced.
		const evicted = latest.length >= 100 ? previous.filter((message) => message.seq < first) : [];
		retained.current = { path: pathname, messages: [...evicted, ...latest] };
		const kept = new Set(evicted.map((message) => message.seq));
		return [
			...history.older.filter((message) => message.seq < first && !kept.has(message.seq)),
			...evicted,
			...latest,
		].sort((a, b) => a.seq - b.seq);
	}, [history.older, view, pathname]);
	const heightBefore = useRef<number | null>(null);
	const loadOlder = useCallback(() => {
		heightBefore.current = document.documentElement.scrollHeight;
		history.loadOlder();
	}, [history]);
	useLayoutEffect(() => {
		if (heightBefore.current === null) return;
		window.scrollBy(0, document.documentElement.scrollHeight - heightBefore.current);
		heightBefore.current = null;
	}, [history.older]);
	// A failed or empty request, or a new topic, leaves no correction to apply.
	useEffect(() => {
		if (!history.loading) heightBefore.current = null;
	}, [history.loading, history.failed, pathname]);

	// The newest message under each top-level topic, from the recent messages already loaded (root only).
	const latestIn = useMemo(() => {
		const latest = new Map<string, BoardMessage>();
		if (path !== "" || view === undefined) return latest;
		for (const message of view.messages) {
			const top = message.topic.split("/")[0] ?? message.topic;
			const current = latest.get(top);
			if (current === undefined || current.seq < message.seq) latest.set(top, message);
		}
		return latest;
	}, [path, view]);

	const authRequired = error?.status === 401;
	const segments = path?.split("/") ?? [];
	const description = path
		? typeof view?.meta.description === "string"
			? view.meta.description
			: undefined
		: undefined;
	const status = path && typeof view?.meta.status === "string" ? view.meta.status : undefined;
	// Alphabetical, so the sidebar never reshuffles under the pointer when a message arrives.
	const sidebarTopics = useMemo(
		() => [...(root?.subtopics ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
		[root],
	);
	const topicPaths = useMemo(
		() => [...new Set([...(root?.subtopics ?? []).map((item) => item.path), ...(path ? [path] : [])])],
		[root, path],
	);
	return (
		<BoardLayout
			wide={path !== null && path !== "" && view !== undefined && hasTopicContext(view)}
			navigation={<TopicNav path={searchPage ? null : path} topics={sidebarTopics} />}
			sidebar={
				<label className="mx-2.5 mt-4 flex cursor-pointer items-center gap-2 text-[13px] text-slate hover:text-ink">
					<input
						type="checkbox"
						className="size-3.5 accent-ink"
						checked={showArchived}
						onChange={(event) => setShowArchived(event.target.checked)}
					/>
					Show archived
				</label>
			}
		>
			{/* Keyed per path: drafts and panel state reset on navigation; layout and data do not. */}
			<ComposerBridgeContext.Provider value={bridge}>
				<div key={pathname} className="flex flex-1 flex-col">
					<PageHeader
						breadcrumb={
							path ? (
								<>
									<Link href="/">Board</Link>
									{segments.slice(0, -1).map((segment, index) => (
										<span key={index}>
											{" / "}
											<Link href={topicHref(segments.slice(0, index + 1).join("/"))}>{segment}</Link>
										</span>
									))}
								</>
							) : (
								"Board"
							)
						}
						title={
							searchPage ? (
								"Search"
							) : path === null ? (
								"Page not found"
							) : path === "" ? (
								"All topics"
							) : (
								<span className="inline-flex items-baseline gap-1">
									<span className="font-normal text-slate/70">#</span>
									{segments.at(-1)}
								</span>
							)
						}
						description={
							searchPage ? (
								"Messages across the board. Filter with from:, in: and tag:."
							) : path === "" ? (
								"Everything happening across your board."
							) : description !== undefined || status !== undefined ? (
								<>
									{status !== undefined && (
										<Badge className="mr-2 align-[1px]" variant="default">
											{status}
										</Badge>
									)}
									{description}
								</>
							) : undefined
						}
						actions={
							<div className="flex shrink-0 items-center gap-1">
								<span
									className="mr-2 hidden items-center gap-1.5 text-[12.5px] text-slate sm:flex"
									title="Updates appear as they happen"
								>
									<span className="size-1.5 rounded-full bg-leaf ring-[3px] ring-leaf/15" />
									Live
								</span>
								<Tooltip content="Refresh">
									<Button
										variant="ghost"
										size="icon"
										className="size-9"
										onClick={reload}
										disabled={loading || path === null}
										aria-label="Refresh"
									>
										<RefreshCw className={cn(loading && "animate-spin")} />
									</Button>
								</Tooltip>
								{path && fresh && view && (
									<Tooltip content="Topic settings">
										<Button
											variant="ghost"
											size="icon"
											className="size-9"
											onClick={() => setSettingsOpen(true)}
											aria-label="Topic settings"
										>
											<Settings2 />
										</Button>
									</Tooltip>
								)}
							</div>
						}
					/>
					{path === null ? (
						<EmptyState title="This page does not exist.">
							<Link href="/">Back to the board</Link>
						</EmptyState>
					) : (
						<div
							className={cn(
								"flex flex-1 flex-col",
								path !== "" &&
									view !== undefined &&
									hasTopicContext(view) &&
									"xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:items-start xl:gap-10",
							)}
						>
							<div className="flex min-h-full min-w-0 flex-1 flex-col">
								{authRequired ? (
									<Alert className="mb-5">
										<h2>Sign in to your board</h2>
										<p>Use your passkey to read and write messages.</p>
										<a
											className={cn(buttonVariants(), "mt-2")}
											href={`/auth/login?next=${encodeURIComponent(pathname)}`}
										>
											Sign in with a passkey
										</a>
										<p className="mt-3">
											<a href="/onboarding">First visit? Set up this board</a>
										</p>
									</Alert>
								) : error && error.status === 404 && view === undefined ? (
									<EmptyState title="This view has no messages yet">
										Write the first message below and the view starts with it.
									</EmptyState>
								) : error ? (
									<LoadProblem error={error} stale={view !== undefined} retrying={retry.waiting} onRetry={reload} />
								) : null}
								{view === undefined && !error && <MessagesSkeleton />}
								{view && !authRequired && (
									<>
										{path !== "" && fresh && (
											<TopicSettings
												open={settingsOpen}
												onOpenChange={setSettingsOpen}
												path={path}
												meta={view.meta}
												archived={view.archived_at !== null}
												parentArchived={view.archived_root !== null && view.archived_root !== path}
												onSaved={(saved) => {
													update(
														(previous) =>
															previous && {
																...previous,
																topic: {
																	...previous.topic,
																	meta: saved.meta,
																	archived_at: saved.archived_at,
																	archived_root: saved.archived_at !== null ? path : null,
																},
															},
													);
													reload();
												}}
											/>
										)}
										{view.archived_root !== null && (
											<Alert className="mb-5">
												This view is read-only because{" "}
												<Link href={topicHref(view.archived_root)}>{view.archived_root}</Link> is archived.
											</Alert>
										)}
										{path !== "" && !searching && <TopicContextBar key={path} path={path} view={view} />}
										{path === "" && !searching && !searchPage && view.index !== null && (
											<section
												className="mb-6 rounded-2xl bg-card px-5 py-5 shadow-raised sm:px-6"
												aria-label="Topic README"
											>
												<Markdown body={view.index} base={`/p/${path ? path + "/" : ""}index.md`} />
											</section>
										)}
										{path === "" && !searching && !searchPage && view.subtopics.length > 0 && (
											<section className="mb-6" aria-label="Topics">
												<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-[1900px]:grid-cols-3">
													{view.subtopics.map((item) => (
														<TopicCard
															key={item.path}
															path={item.path}
															href={topicHref(item.path)}
															className="group flex items-start gap-3 rounded-xl bg-card px-4 py-3 shadow-raised transition-shadow hover:shadow-[0_0_0_1px_rgb(32_42_58/0.14),0_1px_3px_rgb(32_42_58/0.06),0_8px_20px_-8px_rgb(32_42_58/0.14)]"
														>
															<span className="min-w-0 flex-1">
																<span className="flex items-center gap-1.5 text-[14.5px] font-medium text-ink">
																	<span className="font-normal text-slate">#</span>
																	<span className="truncate">{item.name}</span>
																	{item.archived_at !== null && (
																		<span className="text-[12px] font-normal text-slate">archived</span>
																	)}
																</span>
																{latestIn.get(item.path) !== undefined ? (
																	<LatestLine message={latestIn.get(item.path)} />
																) : (
																	(typeof item.meta.description === "string" ||
																		typeof item.meta.status === "string") && (
																		<span className="mt-0.5 block truncate text-[13px] text-slate">
																			{typeof item.meta.status === "string" && (
																				<span className="font-medium text-ink-soft">{item.meta.status} · </span>
																			)}
																			{typeof item.meta.description === "string" ? item.meta.description : ""}
																		</span>
																	)
																)}
															</span>
															{item.unread > 0 && (
																<Badge variant="count" className="mt-0.5" title={`${item.unread} unread`}>
																	{item.unread > 99 ? "99+" : item.unread}
																</Badge>
															)}
														</TopicCard>
													))}
												</div>
											</section>
										)}
										{path === "" && !searching && !searchPage && view.pages.length > 0 && (
											<section className="mb-6 flex flex-wrap items-center gap-1.5" aria-label="Pages">
												<span className="mr-1 text-[12.5px] font-medium text-slate">Pages</span>
												{view.pages.map((file) => (
													<a
														key={file}
														href={`/p/${[...path.split("/").filter(Boolean), file].map(encodeURIComponent).join("/")}`}
														className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-card px-2.5 text-[13.5px] text-ink-soft shadow-raised transition-colors hover:text-ink [&_svg]:size-3.5 [&_svg]:text-slate"
													>
														<FileText />
														{file === "index.md" && view.index !== null ? "README" : file}
													</a>
												))}
											</section>
										)}
										<Search path={path} onActive={setSearching} autoFocus={searchPage} />
										{!searching && !searchPage && (
											<>
												<ReferencedMessage visible={view.messages} />
												<section className="flex-1 pb-2" aria-label="Messages">
													{path !== "" && armedPath === pathname && view.messages.length >= 100 && (
														<HistoryEdge
															done={history.done}
															loading={history.loading}
															failed={history.failed}
															onReach={loadOlder}
														/>
													)}
													{view.messages.length === 0 ? (
														<EmptyState title="No messages yet">
															Say hello below, or invite an agent from the <a href="/init">agent guide</a>.
														</EmptyState>
													) : (
														<>
															<h2 className="sr-only">{path ? "Messages" : "Recent messages"}</h2>
															<MessageList
																messages={shownMessages}
																currentTopic={path || undefined}
																unreadFrom={firstUnread?.path === pathname ? firstUnread.seq : undefined}
															/>
														</>
													)}
												</section>
											</>
										)}
									</>
								)}
								{/* Hidden, not unmounted, during search: an uncertain send keeps its retry state. */}
								{!searchPage && ((view && view.archived_root === null) || error?.status === 404) && (
									<Composer
										path={path}
										topics={topicPaths}
										onSent={onSent}
										sessionExpired={authRequired}
										bridge={composer}
										hidden={searching}
									/>
								)}
							</div>
							{path !== "" && view !== undefined && <TopicRail path={path} view={view} />}
						</div>
					)}
				</div>
			</ComposerBridgeContext.Provider>
		</BoardLayout>
	);
}
