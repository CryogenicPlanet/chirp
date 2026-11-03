"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DashboardBoardResponse, type DashboardBoard } from "../../../dashboard-contract.ts";
import { useAnalyticsIdentity } from "../../analytics.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "../../dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "../../dashboard-shell.tsx";
import { pollDashboardBoard } from "../../poll-dashboard-board.ts";
import { DeleteBoardDialog } from "../../delete-board-dialog.tsx";
import { BoardSetupPanel } from "../../board-setup-panel.tsx";
import { OpenBoardButton } from "../../open-board-button.tsx";
import type { IssuedSetupCode } from "../../open-board.ts";
import { BoardProgressPanel } from "../../board-progress-panel.tsx";
import { boardStatusBanner } from "../../board-status-banner.ts";
import { StatusBadge } from "../../status-badge.tsx";
import { EntryScreen, entryLede, entryTitle } from "../../entry-screen.tsx";
import { buttonVariants } from "../../components/ui/button.tsx";

class BoardNotFound extends Error {}
class SessionExpired extends Error {}

const storageLabels = { sqlite: "Managed SQLite", postgres: "External PostgreSQL", mysql: "External MySQL" } as const;

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const bannerTones = {
	progress: "bg-card text-ink shadow-raised",
	warning: "bg-danger/6 text-danger ring-1 ring-danger/20",
	error: "bg-danger/6 text-danger ring-1 ring-danger/20",
} as const;

const card = "rounded-2xl bg-card p-5 shadow-raised";

export function BoardDetail({
	authUnavailable,
	boardId,
	sessionUser,
}: {
	readonly authUnavailable: boolean;
	readonly boardId: string;
	readonly sessionUser: CloudClientUser | null;
}) {
	const router = useRouter();
	const [setupOpen, setSetupOpen] = useState(false);
	// Open board's fallback replaces any code this panel shows, so it remounts with the one Open board issued.
	const [setupGeneration, setSetupGeneration] = useState(0);
	const [setupCode, setSetupCode] = useState<IssuedSetupCode>();
	const deletionObserved = useRef(false);
	const [board, setBoard] = useState<DashboardBoard>();
	useAnalyticsIdentity(sessionUser);
	const [error, setError] = useState<string>();
	const [pollVersion, setPollVersion] = useState(0);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
				cache: "no-store",
				signal: signal ?? null,
			});
			if (response.status === 401) throw new SessionExpired();
			if (response.status === 404) throw new BoardNotFound();
			return (await readDashboardResponse(response, DashboardBoardResponse)).board;
		},
		[boardId],
	);

	useEffect(() => {
		if (!sessionUser) return;
		const controller = new AbortController();
		setError(undefined);
		void pollDashboardBoard({
			signal: controller.signal,
			load,
			onBoard: (value) => {
				deletionObserved.current = value.phase === "deleting";
				setBoard(value);
				setError(undefined);
			},
			onError: (cause) => {
				if (cause instanceof BoardNotFound) {
					if (deletionObserved.current) router.replace("/");
					else {
						setBoard(undefined);
						setError("This board was not found.");
					}
				} else if (cause instanceof SessionExpired) setError("Your session expired. Sign in again to continue.");
				else setError(dashboardErrorMessage(cause));
			},
			shouldRetry: (cause) => !(cause instanceof BoardNotFound) && !(cause instanceof SessionExpired),
		});
		return () => controller.abort();
	}, [load, pollVersion, sessionUser, router]);

	const refresh = () => {
		setError(undefined);
		setPollVersion((version) => version + 1);
	};
	const banner = board ? boardStatusBanner(board) : null;

	if (!sessionUser)
		return (
			<EntryScreen labelledBy="session-title">
				<p className="mt-0 mb-2 text-[13.5px] font-medium text-slate">
					{authUnavailable ? "Authentication unavailable" : "Session required"}
				</p>
				<h1 className={entryTitle} id="session-title">
					{authUnavailable ? "Your session could not be checked." : "Sign in to view this board."}
				</h1>
				<p className={entryLede}>
					{authUnavailable
						? "Authentication is temporarily unavailable. Try again shortly."
						: "Cloud access and board access use separate credentials."}
				</p>
				<Link className={`${buttonVariants()} w-full no-underline`} href="/">
					{authUnavailable ? "Return to dashboard" : "Go to sign in"}
				</Link>
			</EntryScreen>
		);

	return (
		<DashboardShell user={sessionUser}>
			{error ? (
				<div
					role="alert"
					className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-danger/6 px-5 py-4 text-danger ring-1 ring-danger/20"
				>
					<p className="m-0 text-[14.5px] leading-[1.5]">{error}</p>
					<button className={buttonVariants({ variant: "outline", size: "sm" })} onClick={refresh} type="button">
						Try again
					</button>
				</div>
			) : null}
			{!board && error ? null : !board ? (
				<div aria-label="Loading board">
					<div className="h-5 w-[120px] rounded-md bg-wash" />
					<div className="mt-2.5 h-9 w-full max-w-80 rounded-lg bg-wash" />
					<div className="mt-2.5 h-6 w-full max-w-64 rounded-md bg-wash" />
					<div className="mt-7 min-h-[170px] rounded-2xl bg-card shadow-raised" />
				</div>
			) : (
				<>
					<header className="mb-7">
						<p className="mt-0 mb-2 text-[13.5px] leading-5 text-slate [overflow-wrap:anywhere]">
							<Link
								className="rounded-sm text-inherit underline decoration-slate/40 underline-offset-[3px] hover:text-ink hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
								href="/"
							>
								Boards
							</Link>{" "}
							/ {board.name}
						</p>
						<div className="grid items-start gap-4 min-[761px]:flex min-[761px]:justify-between min-[761px]:gap-6">
							<div className="min-w-0">
								<h1 className="m-0 text-[32px] leading-[1.1] font-[650] tracking-[-0.035em] [overflow-wrap:anywhere] max-[760px]:text-[28px]">
									{board.name}
								</h1>
								<p className="mt-2 mb-0 text-[15.5px] leading-normal text-slate [overflow-wrap:anywhere]">
									{board.hostname ??
										(board.phase === "deleting"
											? "This board’s hosting resources are being removed."
											: board.phase === "deletion_blocked"
												? "Deletion needs administrator attention before it can continue."
												: "Your board address will appear when setup is complete.")}
								</p>
							</div>
							<div className="flex flex-wrap items-center justify-start gap-x-3 gap-y-2 min-[761px]:shrink-0 min-[761px]:justify-end">
								<span className="max-[760px]:basis-full">
									<StatusBadge phase={board.phase} />
								</span>
								<DeleteBoardDialog
									board={board}
									onDeleted={() => {
										deletionObserved.current = true;
										refresh();
									}}
								/>
								{board.hostname && board.phase === "ready" ? (
									<OpenBoardButton
										boardId={board.id}
										hostname={board.hostname}
										className={`${buttonVariants()} min-w-[136px] disabled:cursor-wait disabled:opacity-70`}
										onOpening={() => {
											setSetupCode(undefined);
											setSetupGeneration((generation) => generation + 1);
										}}
										onSetupCode={(code) => {
											flushSync(() => {
												setSetupOpen(true);
												setSetupCode(code);
												setSetupGeneration((generation) => generation + 1);
											});
											document.getElementById("board-setup")?.scrollIntoView({ block: "center" });
										}}
									/>
								) : null}
							</div>
						</div>
					</header>
					{banner ? (
						<div
							role="alert"
							className={`mb-4 rounded-2xl px-5 py-4 text-[14.5px] leading-[1.55] ${bannerTones[banner.severity]}`}
						>
							<p className="mt-0 mb-1 font-semibold first-letter:uppercase">{banner.label}</p>
							<p className="m-0">{banner.message}</p>
							<p className="mt-1.5 mb-0 text-slate">{banner.note}</p>
						</div>
					) : null}
					<div className="grid gap-4">
						{board.phase !== "ready" ? <BoardProgressPanel board={board} className={card} onRefresh={refresh} /> : null}
						<section aria-labelledby="backup" className={card}>
							<h2 id="backup" className="m-0 text-[13.5px] font-medium text-slate">
								Latest backup
							</h2>
							<p className="mt-1 mb-0 text-[19px] font-[650] tracking-[-0.02em]">
								{board.storage_engine !== "sqlite"
									? "Manage backups with your database provider"
									: board.last_backup
										? formatDate(board.last_backup.created_at)
										: "No completed backups yet"}
							</p>
							{board.last_backup ? (
								<p className="mt-1.5 mb-0 text-[13.5px] text-slate">
									Retained for {board.last_backup.retention_days} days, as reported by your provider.
								</p>
							) : null}
						</section>
						<details className={`group ${card}`}>
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md text-[15px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
								Technical details
								<ChevronDown
									aria-hidden="true"
									className="size-4 shrink-0 text-slate transition-transform group-open:rotate-180 motion-reduce:transition-none"
								/>
							</summary>
							<dl className="mt-4 mb-0 grid gap-4 text-[14.5px] sm:grid-cols-2">
								<div>
									<dt className="text-[13.5px] text-slate">Database</dt>
									<dd className="mt-1 ml-0">{storageLabels[board.storage_engine]}</dd>
								</div>
								<div>
									<dt className="text-[13.5px] text-slate">Region</dt>
									<dd className="mt-1 ml-0">{board.region ?? "Pending"}</dd>
								</div>
								{board.storage_engine === "sqlite" ? (
									<div>
										<dt className="text-[13.5px] text-slate">Storage capacity</dt>
										<dd className="mt-1 ml-0">
											{board.volume_size_gb ? `${board.volume_size_gb} GB allocated` : "Pending"}
										</dd>
									</div>
								) : null}
								<div>
									<dt className="text-[13.5px] text-slate">Created</dt>
									<dd className="mt-1 ml-0">{formatDate(board.created_at)}</dd>
								</div>
								{board.last_backup ? (
									<div className="sm:col-span-2">
										<dt className="text-[13.5px] text-slate">Backup digest</dt>
										<dd className="mt-1 ml-0 font-mono text-[12.5px] break-all">{board.last_backup.digest}</dd>
									</div>
								) : null}
							</dl>
							{board.phase === "ready" ? (
								<BoardProgressPanel board={board} className="mt-5 border-t border-rule pt-5" onRefresh={refresh} />
							) : null}
						</details>
					</div>
					{board.phase === "ready" && board.hostname ? (
						<BoardSetupPanel
							key={`${board.id}:${setupGeneration}`}
							boardId={board.id}
							className={`mt-4 ${card}`}
							hostname={board.hostname}
							initialCode={setupCode}
							onIssued={setSetupCode}
							open={setupOpen}
							onOpenChange={setSetupOpen}
						/>
					) : null}
				</>
			)}
		</DashboardShell>
	);
}
