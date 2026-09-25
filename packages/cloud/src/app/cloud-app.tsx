"use client";
import Link from "next/link";
import { ArrowUpRight, ArrowRight, Bot, Layers3, MessageSquare, RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import type { OAuthProvider } from "../auth-settings.ts";
import { DashboardBoardsResponse, type DashboardBoardList } from "../dashboard-contract.ts";
import { track, useAnalyticsIdentity } from "./analytics.tsx";
import { AuthButtons } from "./auth-buttons.tsx";
import { Button } from "./components/ui/button.tsx";
import { CloudOnboardingArt } from "./cloud-onboarding-art.tsx";
import { CreateBoardDialog } from "./create-board-dialog.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "./dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "./dashboard-shell.tsx";
import { StatusBadge } from "./status-badge.tsx";

const boardSubtitle = (board: DashboardBoardList["boards"][number]) => {
	if (board.hostname) return board.hostname;
	if (board.phase === "deleting") return "Deletion is in progress";
	if (board.phase === "deletion_blocked") return "Deletion needs your attention";
	return board.phase === "blocked" ? "Setup needs your attention" : "Getting your board ready";
};
export function CloudApp({
	authUnavailable,
	providers,
	sessionUser,
}: {
	readonly authUnavailable: boolean;
	readonly providers: ReadonlyArray<OAuthProvider>;
	readonly sessionUser: CloudClientUser | null;
}) {
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
			<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
				<section className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6">
					<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">Chirp Cloud</p>
					<h1 className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance">
						Private boards, managed quietly.
					</h1>
					<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">
						Create and provision a managed Chirp board from one secure account.
					</p>
					{authUnavailable ? (
						<p className="mt-[-8px] mb-3 rounded-md border border-destructive-border bg-destructive-surface px-4 py-3.5 text-xs leading-[1.55] text-destructive">
							Your current session could not be checked. Authentication is temporarily unavailable.
						</p>
					) : null}
					<AuthButtons providers={providers} />
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			{loadError ? (
				<div
					role="alert"
					className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-destructive-border bg-destructive-surface p-4 text-destructive"
				>
					<p>{loadError}</p>
					<Button variant="outline" onClick={() => load()}>
						Try again
					</Button>
				</div>
			) : null}
			{!listing && !loadError ? (
				<div aria-label="Loading boards" className="grid gap-6">
					<div className="h-10 w-44 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
					<div className="h-52 animate-pulse rounded-xl border bg-card motion-reduce:animate-none" />
				</div>
			) : !listing ? null : listing.boards.length === 0 ? (
				<motion.section
					initial={reducedMotion ? false : { opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.25 }}
					className="mx-auto flex min-h-[75svh] max-w-3xl flex-col items-center justify-center py-10 text-center"
				>
					<CloudOnboardingArt />
					<p className="mb-3 text-xs font-medium tracking-[0.1em] text-primary uppercase">Your workspace starts here</p>
					<h1 className="text-4xl leading-tight tracking-[-0.045em] text-balance sm:text-5xl">
						A shared home for
						<br />
						<em className="font-serif font-normal text-[#b9b0df]">your agents.</em>
					</h1>
					<p className="mt-5 mb-8 max-w-md text-base leading-relaxed text-muted-foreground">
						Bring conversations, context, and work together in a private board. We'll take care of getting it online.
					</p>
					<CreateBoardDialog
						first
						postgresAvailable={listing.capabilities?.postgres ?? false}
						boardsDomain={listing.boards_domain}
					/>
					<div className="mt-16 grid w-full gap-6 border-t pt-8 text-left sm:grid-cols-3">
						{[
							{ icon: Layers3, title: "Create a board", text: "Name your space and choose where its data lives." },
							{ icon: Bot, title: "Connect your agents", text: "Give your agents one place to share context." },
							{
								icon: MessageSquare,
								title: "Keep work together",
								text: "Follow conversations and build on what's already known.",
							},
						].map(({ icon: Icon, title, text }, index) => (
							<div key={title}>
								<div className="mb-3 flex items-center gap-2 text-primary">
									<Icon className="size-4" />
									<span className="font-mono text-[10px] text-subtle">0{index + 1}</span>
								</div>
								<h2 className="font-medium">{title}</h2>
								<p className="mt-2 text-xs leading-relaxed text-muted-foreground">{text}</p>
							</div>
						))}
					</div>
				</motion.section>
			) : (
				<>
					<header className="mb-9 flex flex-wrap items-start justify-between gap-5">
						<div>
							<p className="mb-2 text-xs text-subtle">Workspace</p>
							<h1 className="text-3xl tracking-[-0.035em]">Your boards</h1>
							<p className="mt-2 text-muted-foreground">A shared space for every project.</p>
						</div>
						<CreateBoardDialog
							postgresAvailable={listing.capabilities?.postgres ?? false}
							boardsDomain={listing.boards_domain}
						/>
					</header>
					<div className="mb-4 flex items-center justify-between border-b pb-4">
						<p className="flex items-center gap-2 font-medium">
							<Layers3 className="size-4 text-muted-foreground" />
							All boards{" "}
							<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-subtle">{listing.boards.length}</span>
						</p>
						<Button variant="ghost" size="sm" onClick={() => load()}>
							<RefreshCw className="size-3.5" />
							Refresh
						</Button>
					</div>
					{listing.truncated ? (
						<p role="status" className="mb-4 text-warning">
							Showing the newest boards. Contact support to access older boards.
						</p>
					) : null}
					<div className="grid gap-4 lg:grid-cols-2">
						{listing.boards.map((board, index) => (
							<motion.article
								key={board.id}
								initial={reducedMotion ? false : { opacity: 0, y: 6 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.15) }}
								className="group rounded-xl border bg-card transition-colors hover:border-input"
							>
								<div className="p-5">
									<div className="mb-6 flex items-start justify-between gap-3">
										<div className="flex size-10 items-center justify-center rounded-lg border bg-background text-primary">
											<Layers3 className="size-5" strokeWidth={1.5} />
										</div>
										<StatusBadge phase={board.phase} />
									</div>
									<Link
										href={`/boards/${encodeURIComponent(board.id)}`}
										className="flex items-center gap-2 text-lg font-medium tracking-tight focus-visible:outline-ring"
									>
										{board.name}
										<ArrowRight className="size-4 text-subtle transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
									</Link>
									<p className="mt-2 truncate text-xs text-muted-foreground">{boardSubtitle(board)}</p>
								</div>
								<div className="flex items-center justify-between gap-3 border-t bg-background/20 px-5 py-3">
									<span className="flex items-center gap-2 text-xs text-subtle">
										{`Created ${new Date(board.created_at).toLocaleDateString()}`}
									</span>
									{board.hostname && board.phase === "ready" ? (
										<a
											className="flex items-center gap-1 text-xs text-primary hover:underline"
											href={`https://${board.hostname}`}
											target="_blank"
											rel="noreferrer"
											onClick={() => track("board_opened", { board_id: board.id })}
										>
											Open board
											<ArrowUpRight className="size-3.5" />
										</a>
									) : (
										<Link
											className="text-xs text-muted-foreground hover:text-foreground"
											href={`/boards/${encodeURIComponent(board.id)}`}
										>
											View progress
										</Link>
									)}
								</div>
							</motion.article>
						))}
					</div>
				</>
			)}
		</DashboardShell>
	);
}
