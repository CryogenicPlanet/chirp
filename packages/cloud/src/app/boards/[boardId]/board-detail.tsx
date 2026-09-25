"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardBoardResponse, type DashboardBoard } from "../../../dashboard-contract.ts";
import { useAnalyticsIdentity, useTrack } from "../../analytics.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "../../dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "../../dashboard-shell.tsx";
import { pollDashboardBoard } from "../../poll-dashboard-board.ts";
import { DeleteBoardDialog } from "../../delete-board-dialog.tsx";
import { BoardSetupPanel } from "../../board-setup-panel.tsx";
import { BoardProgressPanel } from "../../board-progress-panel.tsx";
import { boardStatusBanner } from "../../board-status-banner.ts";
import { StatusBadge } from "../../status-badge.tsx";

class BoardNotFound extends Error {}

const storageLabels = { sqlite: "Managed SQLite", postgres: "External PostgreSQL", mysql: "External MySQL" } as const;

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const bannerTones = {
	progress: "border-border bg-muted text-muted-foreground",
	warning: "border-warning-border bg-warning-surface text-warning",
	error: "border-destructive-border bg-destructive-surface text-destructive",
} as const;

export function BoardDetail({
	authUnavailable,
	boardId,
	sessionUser,
}: {
	readonly authUnavailable: boolean;
	readonly boardId: string;
	readonly sessionUser: CloudClientUser | null;
}) {
	const track = useTrack();
	const router = useRouter();
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
			},
			onError: (cause) => {
				if (cause instanceof BoardNotFound) {
					if (deletionObserved.current) router.replace("/");
					else {
						setBoard(undefined);
						setError("This board was not found.");
					}
				} else setError(dashboardErrorMessage(cause));
			},
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
			<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
				<section className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6">
					<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
						{authUnavailable ? "Authentication unavailable" : "Session required"}
					</p>
					<h1 className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance">
						{authUnavailable ? "Your session could not be checked." : "Sign in to view this board."}
					</h1>
					<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">
						{authUnavailable
							? "Authentication is temporarily unavailable. Try again shortly."
							: "Cloud access and board access use separate credentials."}
					</p>
					<Link
						className="inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground no-underline hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						href="/"
					>
						{authUnavailable ? "Return to dashboard" : "Go to sign in"}
					</Link>
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			{error ? (
				<div
					role="alert"
					className="mb-3 rounded-md border border-destructive-border bg-destructive-surface px-4 py-3.5 text-xs leading-[1.55] text-destructive"
				>
					<p className="m-0">{error}</p>
					<button
						className="mt-2.5 inline-flex min-h-[30px] cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-2.5 py-1.5 text-xs font-medium leading-none text-foreground hover:border-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						onClick={refresh}
						type="button"
					>
						Try again
					</button>
				</div>
			) : null}
			{!board && error ? null : !board ? (
				<div aria-label="Loading board" className="pt-[3px]">
					<div className="h-[11px] w-[92px] animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
					<div className="mt-3.5 h-[34px] w-full max-w-80 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
					<div className="mt-8 min-h-[170px] animate-pulse rounded-md border border-border bg-card shadow-card motion-reduce:animate-none" />
				</div>
			) : (
				<>
					<header className="mb-7">
						<p className="mt-0 mb-2 font-mono text-[11px] tracking-[0.03em] text-subtle">
							<Link
								className="text-inherit underline decoration-input underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								href="/"
							>
								Boards
							</Link>{" "}
							/ {board.name}
						</p>
						<div className="grid items-start gap-4 min-[761px]:flex min-[761px]:justify-between min-[761px]:gap-6">
							<div>
								<h1 className="m-0 text-3xl font-normal tracking-[-0.035em] text-balance max-[760px]:text-2xl">
									{board.name}
								</h1>
								<p className="mt-2 mb-0 leading-normal text-muted-foreground [overflow-wrap:anywhere]">
									{board.hostname ??
										(board.phase === "deleting"
											? "This board’s hosting resources are being removed."
											: board.phase === "deletion_blocked"
												? "Deletion needs administrator attention before it can continue."
												: "Your board address will appear when setup is complete.")}
								</p>
							</div>
							<div className="flex flex-wrap items-center justify-start gap-2 min-[761px]:justify-end">
								<StatusBadge phase={board.phase} />
								<DeleteBoardDialog
									board={board}
									onDeleted={() => {
										deletionObserved.current = true;
										refresh();
									}}
								/>
								{board.hostname && board.phase === "ready" ? (
									<a
										className="inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground no-underline hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										href={`https://${board.hostname}`}
										onClick={() => track("board_opened", { board_id: board.id })}
										rel="noreferrer"
										target="_blank"
									>
										Open board
									</a>
								) : null}
							</div>
						</div>
					</header>
					{banner ? (
						<div
							role="alert"
							className={`mb-3 rounded-md border px-4 py-3.5 text-xs leading-[1.55] ${bannerTones[banner.severity]}`}
						>
							<p className="mt-0 mb-[5px] font-mono text-[11px] font-medium tracking-[0.08em] uppercase">
								{banner.label}
							</p>
							<p className="m-0">{banner.message}</p>
							<p className="mt-1.5 mb-0 text-muted-foreground">{banner.note}</p>
						</div>
					) : null}
					<div className="grid gap-4">
						{board.phase !== "ready" ? <BoardProgressPanel board={board} onRefresh={refresh} /> : null}
						<section aria-labelledby="backup" className="rounded-md border border-border bg-card p-5">
							<h2 id="backup" className="text-sm font-medium">
								Latest backup
							</h2>
							<p className="mt-3 text-xl tracking-tight">
								{board.storage_engine !== "sqlite"
									? "Manage backups with your database provider"
									: board.last_backup
										? formatDate(board.last_backup.created_at)
										: "No completed backups yet"}
							</p>
							{board.last_backup ? (
								<p className="mt-2 text-xs text-muted-foreground">
									Retained for {board.last_backup.retention_days} days, as reported by your provider.
								</p>
							) : null}
						</section>
						<details className="rounded-md border border-border bg-card p-5">
							<summary className="cursor-pointer text-sm font-medium focus-visible:outline-ring">
								Technical details
							</summary>
							<dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
								<div>
									<dt className="text-subtle">Database</dt>
									<dd className="mt-1">{storageLabels[board.storage_engine]}</dd>
								</div>
								<div>
									<dt className="text-subtle">Region</dt>
									<dd className="mt-1">{board.region ?? "Pending"}</dd>
								</div>
								{board.storage_engine === "sqlite" ? (
									<div>
										<dt className="text-subtle">Storage capacity</dt>
										<dd className="mt-1">
											{board.volume_size_gb ? `${board.volume_size_gb} GB allocated` : "Pending"}
										</dd>
									</div>
								) : null}
								<div>
									<dt className="text-subtle">Created</dt>
									<dd className="mt-1">{formatDate(board.created_at)}</dd>
								</div>
								{board.last_backup ? (
									<div className="sm:col-span-2">
										<dt className="text-subtle">Backup digest</dt>
										<dd className="mt-1 break-all font-mono text-xs">{board.last_backup.digest}</dd>
									</div>
								) : null}
							</dl>
							{board.phase === "ready" ? (
								<div className="mt-5">
									<BoardProgressPanel board={board} onRefresh={refresh} />
								</div>
							) : null}
						</details>
					</div>
					{board.phase === "ready" && board.hostname ? (
						<BoardSetupPanel key={board.id} boardId={board.id} hostname={board.hostname} />
					) : null}
				</>
			)}
		</DashboardShell>
	);
}
