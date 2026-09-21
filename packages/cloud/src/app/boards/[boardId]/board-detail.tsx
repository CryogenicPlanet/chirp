"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardBoardResponse, type DashboardBoard } from "../../../dashboard-contract.ts";
import { dashboardErrorMessage, readDashboardResponse } from "../../dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "../../dashboard-shell.tsx";
import { pollDashboardBoard } from "../../poll-dashboard-board.ts";
import { DeleteBoardDialog } from "../../delete-board-dialog.tsx";
import { BoardProgressPanel } from "../../board-progress-panel.tsx";
import { StatusBadge } from "../../status-badge.tsx";

class BoardNotFound extends Error {}

const storageLabels = { sqlite: "Managed SQLite", postgres: "External PostgreSQL", mysql: "External MySQL" } as const;

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

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
	const deletionObserved = useRef(false);
	const [board, setBoard] = useState<DashboardBoard>();
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
										rel="noreferrer"
										target="_blank"
									>
										Open board
									</a>
								) : null}
							</div>
						</div>
					</header>
					{board.error ? (
						<div
							role="alert"
							className={`mb-3 rounded-md border px-4 py-3.5 text-xs leading-[1.55] ${board.error.retrying ? "border-warning-border bg-warning-surface text-warning" : "border-destructive-border bg-destructive-surface text-destructive"}`}
						>
							<p className="mt-0 mb-[5px] font-mono text-[11px] font-medium tracking-[0.08em] uppercase">
								{board.error.code.replaceAll("_", " ")}
							</p>
							<p className="m-0">{board.error.message}</p>
							<p className="mt-1.5 mb-0 text-muted-foreground">
								{board.error.retrying ? "We’ll retry automatically." : "Contact your Cloud administrator for help."}
							</p>
						</div>
					) : null}
					<div className="grid items-start gap-3 min-[901px]:grid-cols-2 min-[901px]:grid-rows-[auto_1fr]">
						<div className="min-[901px]:row-span-2">
							<BoardProgressPanel board={board} onRefresh={refresh} />
						</div>
						<section
							aria-labelledby="configuration"
							className="rounded-md border border-border bg-card p-5 shadow-card"
						>
							<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
								Configuration
							</p>
							<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance" id="configuration">
								{storageLabels[board.storage_engine]}
							</h2>
							<dl className="mt-[18px] mb-0">
								<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1">
									<dt className="text-subtle">Region</dt>
									<dd className="m-0 text-foreground [overflow-wrap:anywhere]">{board.region ?? "Pending"}</dd>
								</div>
								{board.storage_engine === "sqlite" ? (
									<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1">
										<dt className="text-subtle">Persistent volume</dt>
										<dd className="m-0 text-foreground [overflow-wrap:anywhere]">
											{board.volume_size_gb ? `${board.volume_size_gb} GB` : "Pending"}
										</dd>
									</div>
								) : null}
							</dl>
						</section>
						<section aria-labelledby="backup" className="rounded-md border border-border bg-card p-5 shadow-card">
							<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
								Data protection
							</p>
							<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance" id="backup">
								Latest snapshot
							</h2>
							{board.storage_engine !== "sqlite" ? (
								<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
									Manage backups with your database provider.
								</p>
							) : board.last_backup ? (
								<dl className="mt-[18px] mb-0 grid min-[761px]:grid-cols-2 min-[761px]:gap-x-7">
									<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1">
										<dt className="text-subtle">Created</dt>
										<dd className="m-0 text-foreground [overflow-wrap:anywhere]">
											{formatDate(board.last_backup.created_at)}
										</dd>
									</div>
									<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1">
										<dt className="text-subtle">Retention reported by provider</dt>
										<dd className="m-0 text-foreground [overflow-wrap:anywhere]">
											{board.last_backup.retention_days} days
										</dd>
									</div>
									<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1 min-[761px]:col-span-full">
										<dt className="text-subtle">Digest</dt>
										<dd className="m-0 font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
											{board.last_backup.digest}
										</dd>
									</div>
								</dl>
							) : (
								<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">No completed snapshots yet.</p>
							)}
						</section>
					</div>
				</>
			)}
		</DashboardShell>
	);
}
