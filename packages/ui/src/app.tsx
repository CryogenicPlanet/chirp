import { Onboarding, useFirstVisit } from "./onboarding.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { useVisible } from "./use-visible.ts";
import { Atom } from "effect/unstable/reactivity";
import { BoardClientProvider, useBoardClient } from "./board-client.tsx";
import { Effect } from "effect";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { MessageHistory } from "./message-history.tsx";
import { useLoad } from "./use-load.ts";
import { Composer } from "./composer.tsx";
import { LoadProblem, useAutoRetry } from "./load-problem.tsx";
import { Link, useLocation, useScrollOnNavigate } from "./router.tsx";
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

function TopicNav({
	path,
	topics,
}: {
	readonly path: string | null;
	readonly topics: ReadonlyArray<BoardTopic["subtopics"][number]>;
}) {
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
	const path = currentPath(pathname);
	const [showArchived, setShowArchived] = useState(false);
	const [browsingHistory, setBrowsingHistory] = useState(false);
	const [searching, setSearching] = useState(() => new URLSearchParams(search).has("q"));
	const [settingsOpen, setSettingsOpen] = useState(false);
	const composer = useRef<ComposerBridge>(null);
	const bridge = useMemo<ComposerBridge>(() => ({ reply: (reply) => composer.current?.reply(reply) }), []);
	useEffect(() => {
		setBrowsingHistory(false);
		setSettingsOpen(false);
	}, [pathname]);
	const request = useMemo(() => {
		if (path === null) return Atom.make(Effect.succeed(null));
		const root = client.topic("", showArchived, visible && path === "" && !searching && !browsingHistory);
		const topic = path === "" ? root : client.topic(path, showArchived, visible && !searching && !browsingHistory);
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
	}, [client, path, showArchived, searching, browsingHistory, visible]);
	const { value, error, loading, reload, update } = useLoad(request);
	const root = value?.root;
	const topic = value?.topic;
	const onSent = (message: BoardMessage) => {
		setBrowsingHistory(false);
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
	const view = fresh ? topic : undefined;
	const retry = useAutoRetry(error, reload);
	const landed = useRef<string | null>(null);
	const messageCount = fresh ? topic.messages.length : 0;
	useEffect(() => {
		if (!fresh || path === "" || hash !== "" || searching || messageCount === 0 || landed.current === pathname) return;
		landed.current = pathname;
		const frame = requestAnimationFrame(() => {
			window.scrollTo(0, document.documentElement.scrollHeight);
			pinned.current = true;
		});
		return () => cancelAnimationFrame(frame);
	}, [fresh, pathname, path, hash, searching, messageCount]);
	// Stay pinned to the bottom when new messages arrive while reading the latest.
	const lastSeq = fresh ? (topic.messages.at(-1)?.seq ?? 0) : 0;
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
			navigation={<TopicNav path={path} topics={sidebarTopics} />}
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
							path === null ? (
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
							path === "" ? (
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
								{path && view && (
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
						<>
							{authRequired ? (
								<Alert className="mb-5">
									<h2>Sign in to your board</h2>
									<p>Use your passkey to read and write messages.</p>
									<a className={cn(buttonVariants(), "mt-2")} href={`/auth/login?next=${encodeURIComponent(pathname)}`}>
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
									{path !== "" && (
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
									{view.index !== null && (
										<section
											className="mb-6 rounded-2xl bg-card px-5 py-5 shadow-raised sm:px-6"
											aria-label="Topic README"
										>
											<Markdown body={view.index} base={`/p/${path ? path + "/" : ""}index.md`} />
										</section>
									)}
									{view.subtopics.length > 0 && (
										<section className="mb-6" aria-label={path ? "Subtopics" : "Topics"}>
											<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 min-[1900px]:grid-cols-3">
												{view.subtopics.map((item) => (
													<Link
														key={item.path}
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
															{(typeof item.meta.description === "string" || typeof item.meta.status === "string") && (
																<span className="mt-0.5 block truncate text-[13px] text-slate">
																	{typeof item.meta.status === "string" && (
																		<span className="font-medium text-ink-soft">{item.meta.status} · </span>
																	)}
																	{typeof item.meta.description === "string" ? item.meta.description : ""}
																</span>
															)}
														</span>
														{item.unread > 0 && (
															<Badge variant="count" className="mt-0.5" title={`${item.unread} unread`}>
																{item.unread > 99 ? "99+" : item.unread}
															</Badge>
														)}
													</Link>
												))}
											</div>
										</section>
									)}
									{view.pages.length > 0 && (
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
									<Search path={path} onActive={setSearching} />
									{!searching && browsingHistory && (
										<MessageHistory path={path} onClose={() => setBrowsingHistory(false)} />
									)}
									{!searching && !browsingHistory && (
										<>
											<ReferencedMessage visible={view.messages} />
											<section className="flex-1 pb-2" aria-label="Messages">
												{view.messages.length >= 100 && (
													<div className="flex items-center justify-between gap-4 pb-3 text-[13px] text-slate">
														<p>Showing the latest 100 messages.</p>
														{path !== "" && (
															<Button variant="ghost" size="sm" type="button" onClick={() => setBrowsingHistory(true)}>
																Browse older messages
															</Button>
														)}
													</div>
												)}
												{view.messages.length === 0 ? (
													<EmptyState title="No messages yet">
														Say hello below, or invite an agent from the <a href="/init">agent guide</a>.
													</EmptyState>
												) : (
													<>
														<h2 className="sr-only">{path ? "Messages" : "Recent messages"}</h2>
														<MessageList messages={view.messages} currentTopic={path || undefined} />
													</>
												)}
											</section>
										</>
									)}
								</>
							)}
							{((view && view.archived_root === null) || error?.status === 404) && (
								<Composer
									path={path}
									topics={topicPaths}
									onSent={onSent}
									sessionExpired={authRequired}
									bridge={composer}
								/>
							)}
						</>
					)}
				</div>
			</ComposerBridgeContext.Provider>
		</BoardLayout>
	);
}
