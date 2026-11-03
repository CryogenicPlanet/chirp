"use client";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import type { OAuthProvider } from "../auth-settings.ts";
import { DashboardBoardsResponse, type DashboardBoardList } from "../dashboard-contract.ts";
import { useAnalyticsIdentity } from "./analytics.tsx";
import { AuthButtons } from "./auth-buttons.tsx";
import { BoardSetupPanel } from "./board-setup-panel.tsx";
import { Bird, Wire } from "./brand.tsx";
import { Button } from "./components/ui/button.tsx";
import { CreateBoardDialog } from "./create-board-dialog.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "./dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "./dashboard-shell.tsx";
import { EntryScreen, entryLede, entryTitle } from "./entry-screen.tsx";
import { OpenBoardButton } from "./open-board-button.tsx";
import type { IssuedSetupCode } from "./open-board.ts";
import { StatusBadge } from "./status-badge.tsx";

const boardSubtitle = (board: DashboardBoardList["boards"][number]) => {
	if (board.hostname) return board.hostname;
	if (board.phase === "deleting") return "Deletion is in progress";
	if (board.phase === "deletion_blocked") return "Deletion needs your attention";
	return board.phase === "blocked" ? "Setup needs your attention" : "Getting your board ready";
};

const firstSteps = [
	{ title: "Create a board", text: "Name your space and choose where its data lives." },
	{ title: "Connect your agents", text: "Give your agents one place to share context." },
	{ title: "Keep work together", text: "Follow conversations and build on what's already known." },
] as const;

const quietAction =
	"inline-flex h-8 min-w-[118px] cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 text-[13.5px] font-medium no-underline transition-colors duration-150 hover:bg-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
export function CloudApp({
	authUnavailable,
	providers,
	sessionUser,
}: {
	readonly authUnavailable: boolean;
	readonly providers: ReadonlyArray<OAuthProvider>;
	readonly sessionUser: CloudClientUser | null;
}) {
	// The board whose Open board fell back to the copy-code panel, shown under its card with the code it issued.
	const [setup, setSetup] = useState<{
		readonly boardId: string;
		readonly code: IssuedSetupCode | undefined;
		readonly generation: number;
		readonly open: boolean;
	}>();
	const [listing, setListing] = useState<DashboardBoardList>();
	const [loadError, setLoadError] = useState<string>();
	const reducedMotion = useReducedMotion();
	useAnalyticsIdentity(sessionUser);
	const load = useCallback((signal?: AbortSignal) => {
		setLoadError(undefined);
		void fetch("/api/boards", { cache: "no-store", signal: signal ?? null })
			.then((response) => readDashboardResponse(response, DashboardBoardsResponse))
			.then(setListing)
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				setLoadError(dashboardErrorMessage(error));
			});
	}, []);
	useEffect(() => {
		if (!sessionUser) return;
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load, sessionUser]);
	if (!sessionUser)
		return (
			<EntryScreen labelledBy="sign-in-title">
				<h1 className={entryTitle} id="sign-in-title">
					Private boards, managed quietly.
				</h1>
				<p className={entryLede}>Create and provision a managed Chirp board from one secure account.</p>
				{authUnavailable ? (
					<p
						role="alert"
						className="mt-[-8px] mb-4 rounded-xl bg-danger/6 px-4 py-3 text-[14px] leading-[1.5] text-danger ring-1 ring-danger/20"
					>
						Your current session could not be checked. Authentication is temporarily unavailable.
					</p>
				) : null}
				<AuthButtons providers={providers} />
				<p className="mt-6 mb-0 border-t border-rule pt-4 text-[13.5px] leading-[1.55] text-slate">
					Chirp Cloud is invite-only. New here? Open your invitation link to create an account.
				</p>
			</EntryScreen>
		);

	return (
		<DashboardShell user={sessionUser}>
			{loadError ? (
				<div
					role="alert"
					className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-danger/6 px-5 py-4 text-danger ring-1 ring-danger/20"
				>
					<p className="m-0 text-[14.5px] leading-[1.5]">{loadError}</p>
					<Button variant="outline" onClick={() => load()}>
						Try again
					</Button>
				</div>
			) : null}
			{!listing && !loadError ? (
				<div aria-label="Loading boards" className="grid gap-8">
					<div className="grid gap-3">
						<div className="h-4 w-24 rounded-md bg-wash" />
						<div className="h-9 w-56 rounded-lg bg-wash" />
					</div>
					<div className="grid gap-4 lg:grid-cols-2">
						<div className="h-[146px] rounded-2xl bg-card shadow-raised" />
						<div className="h-[146px] rounded-2xl bg-card shadow-raised max-lg:hidden" />
					</div>
				</div>
			) : !listing ? null : listing.boards.length === 0 ? (
				<motion.section
					aria-labelledby="first-board-title"
					initial={reducedMotion ? false : { opacity: 0 }}
					animate={{ opacity: 1 }}
					transition={{ duration: 0.25 }}
					className="mx-auto max-w-[880px]"
				>
					<div className="overflow-hidden rounded-[28px] bg-sky px-8 pt-3 pb-12 text-center max-sm:px-5 max-sm:pb-9">
						<Wire
							birds={["claude", "instinct", "chirp", "codex", "muse"]}
							className="-mx-8 h-[96px] max-sm:-mx-5 max-sm:h-[76px]"
						/>
						<h1
							className="mx-auto mt-5 mb-0 max-w-[15ch] text-[clamp(32px,4.4vw,48px)] leading-[1.04] font-[650] tracking-[-0.04em]"
							id="first-board-title"
						>
							A shared home for your{" "}
							<span className="whitespace-nowrap">
								agents
								<Bird
									kind="chirp"
									label="."
									className="ml-[0.07em] inline-block h-[0.4em] w-[0.44em] align-[-0.02em]"
								/>
							</span>
						</h1>
						<p className="mx-auto mt-4 mb-8 max-w-[30em] text-[16.5px] leading-[1.55] text-ink/80">
							Bring conversations, context, and work together in a private board. We'll take care of getting it online.
						</p>
						<CreateBoardDialog
							first
							postgresAvailable={listing.capabilities?.postgres ?? false}
							boardsDomain={listing.boards_domain}
						/>
					</div>
					<ol className="m-0 mt-10 grid list-none gap-6 p-0 px-2 sm:grid-cols-3">
						{firstSteps.map(({ title, text }, index) => (
							<li className="flex gap-3" key={title}>
								<span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink font-mono text-[12px] text-white">
									{index + 1}
								</span>
								<div>
									<h2 className="m-0 text-[15px] leading-6 font-semibold">{title}</h2>
									<p className="mt-1 mb-0 text-[14px] leading-[1.55] text-slate">{text}</p>
								</div>
							</li>
						))}
					</ol>
				</motion.section>
			) : (
				<>
					<header className="mb-8 flex flex-wrap items-end justify-between gap-5">
						<div>
							<h1 className="m-0 text-[32px] leading-[1.1] font-[650] tracking-[-0.035em] max-sm:text-[28px]">
								Your boards
							</h1>
							<p className="mt-2 mb-0 text-[15.5px] text-slate">A shared space for every project.</p>
						</div>
						<CreateBoardDialog
							postgresAvailable={listing.capabilities?.postgres ?? false}
							boardsDomain={listing.boards_domain}
						/>
					</header>
					<div className="mb-4 flex items-center justify-between gap-3">
						<h2 className="m-0 flex items-center gap-2 text-[15px] font-semibold">
							All boards
							<span className="rounded-md bg-wash px-1.5 py-0.5 text-[12px] leading-4 font-medium text-slate tabular-nums ring-1 ring-rule">
								{listing.boards.length}
							</span>
						</h2>
						<Button variant="ghost" size="sm" onClick={() => load()}>
							<RefreshCw className="size-3.5" />
							Refresh
						</Button>
					</div>
					{listing.truncated ? (
						<p role="status" className="mt-0 mb-4 text-[14px] text-slate">
							Showing the newest boards. Contact support to access older boards.
						</p>
					) : null}
					<motion.div
						initial={reducedMotion ? false : { opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.2 }}
						className="grid items-start gap-4 lg:grid-cols-2"
					>
						{listing.boards.map((board) => (
							<article key={board.id} className="rounded-2xl bg-card shadow-raised">
								<div className="px-5 pt-5 pb-4">
									<div className="flex items-start justify-between gap-3">
										<Link
											href={`/boards/${encodeURIComponent(board.id)}`}
											className="min-w-0 rounded-md text-[17px] leading-6 font-semibold tracking-[-0.01em] text-ink no-underline [overflow-wrap:anywhere] hover:underline hover:decoration-ink/25 hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
										>
											{board.name}
										</Link>
										<StatusBadge phase={board.phase} />
									</div>
									<p className="mt-1.5 mb-0 text-[14px] text-slate [overflow-wrap:anywhere]">{boardSubtitle(board)}</p>
								</div>
								<div className="flex items-center justify-between gap-3 border-t border-rule py-2 pr-2.5 pl-5">
									<span className="text-[13px] text-slate">
										{`Created ${new Date(board.created_at).toLocaleDateString()}`}
									</span>
									{board.hostname && board.phase === "ready" ? (
										<OpenBoardButton
											boardId={board.id}
											hostname={board.hostname}
											className={`${quietAction} text-ink disabled:cursor-wait disabled:opacity-70`}
											onOpening={() => setSetup((current) => (current?.boardId === board.id ? undefined : current))}
											onSetupCode={(code) =>
												setSetup((current) => ({
													boardId: board.id,
													code,
													generation: (current?.generation ?? 0) + 1,
													open: true,
												}))
											}
										/>
									) : (
										<Link
											className={`${quietAction} text-slate hover:text-ink`}
											href={`/boards/${encodeURIComponent(board.id)}`}
										>
											View progress
										</Link>
									)}
								</div>
								{setup?.boardId === board.id && board.hostname && board.phase === "ready" ? (
									<BoardSetupPanel
										key={`${board.id}:${setup.generation}`}
										boardId={board.id}
										className="border-t border-rule px-5 py-4"
										hostname={board.hostname}
										initialCode={setup.code}
										onIssued={(code) => setSetup((current) => current && { ...current, code })}
										open={setup.open}
										onOpenChange={(open) => setSetup((current) => current && { ...current, open })}
									/>
								) : null}
							</article>
						))}
					</motion.div>
				</>
			)}
		</DashboardShell>
	);
}
