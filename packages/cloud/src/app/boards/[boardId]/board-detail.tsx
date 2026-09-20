"use client";

import { Schema } from "effect";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DashboardBoardResponse, type DashboardBoard } from "../../../dashboard-contract.ts";
import { type CloudClientUser, DashboardShell } from "../../dashboard-shell.tsx";
import { pollDashboardBoard } from "../../poll-dashboard-board.ts";
import { StatusBadge } from "../../status-badge.tsx";

const checkpointLabels: Readonly<Record<string, string>> = {
	requested: "Waiting for a provisioning worker",
	storage_configuration_verified: "Storage configuration verified",
	app_created: "Fly application created",
	volume_created: "Persistent volume created",
	runtime_secrets_written: "Runtime secrets configured",
	machine_created: "Board machine created",
	machine_started: "Board machine started",
	edge_reachable: "Fly edge is reachable",
	child_route_observed: "Board route verified",
	provisioned: "Provisioning complete",
	blocked: "Provisioning needs attention",
};
const storageLabels = { sqlite: "Managed SQLite", postgres: "External PostgreSQL", mysql: "External MySQL" } as const;

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function BoardDetail({
	boardId,
	sessionUser,
}: {
	readonly boardId: string;
	readonly sessionUser: CloudClientUser | null;
}) {
	const [board, setBoard] = useState<DashboardBoard>();
	const [error, setError] = useState<string>();
	const [pollVersion, setPollVersion] = useState(0);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
				cache: "no-store",
				signal: signal ?? null,
			});
			if (!response.ok) {
				if (response.status === 401) throw new Error("Your session expired. Sign in again to continue.");
				if (response.status === 404) throw new Error("This board was not found.");
				throw new Error("Chirp Cloud is temporarily unavailable.");
			}
			return Schema.decodeUnknownSync(DashboardBoardResponse)(await response.json()).board;
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
			onBoard: setBoard,
			onError: (cause) => setError(cause instanceof Error ? cause.message : "Chirp Cloud is temporarily unavailable."),
		});
		return () => controller.abort();
	}, [load, pollVersion, sessionUser]);

	const refresh = () => {
		setError(undefined);
		setPollVersion((version) => version + 1);
	};

	if (!sessionUser)
		return (
			<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
				<section className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6">
					<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
						Session required
					</p>
					<h1 className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance">
						Sign in to view this board.
					</h1>
					<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">
						Cloud access and board access use separate credentials.
					</p>
					<Link
						className="inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground no-underline hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						href="/"
					>
						Go to sign in
					</Link>
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			{error ? (
				<div className="mb-3 rounded-md border border-destructive-border bg-destructive-surface px-4 py-3.5 text-xs leading-[1.55] text-destructive">
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
			{!board ? (
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
									{board.hostname ?? "A private hostname will appear after provisioning."}
								</p>
							</div>
							<div className="flex flex-wrap items-center justify-start gap-2 min-[761px]:justify-end">
								<StatusBadge phase={board.phase} />
								{board.hostname ? (
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
							className={`mb-3 rounded-md border px-4 py-3.5 text-xs leading-[1.55] ${board.error.retrying ? "border-warning-border bg-warning-surface text-warning" : "border-destructive-border bg-destructive-surface text-destructive"}`}
						>
							<p className="mt-0 mb-[5px] font-mono text-[11px] font-medium tracking-[0.08em] uppercase">
								{board.error.code.replaceAll("_", " ")}
							</p>
							<p className="m-0">{board.error.message}</p>
							<p className="mt-1.5 mb-0 text-muted-foreground">
								{board.error.retrying
									? "Provisioning will retry automatically."
									: "Refresh after the underlying issue is resolved. No new operation will be created."}
							</p>
						</div>
					) : null}
					<div className="grid gap-3 min-[901px]:grid-cols-2">
						<section aria-labelledby="provisioning" className="rounded-md border border-border bg-card p-5 shadow-card">
							<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
								Provisioning
							</p>
							<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance" id="provisioning">
								{checkpointLabels[board.checkpoint] ?? board.checkpoint.replaceAll("_", " ")}
							</h2>
							<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
								{board.phase === "queued" || board.phase === "provisioning"
									? "This page checks for progress every two seconds."
									: board.phase === "ready"
										? "The generated board route has been observed and published."
										: "Provisioning stopped with a persisted error."}
							</p>
							<button
								className="mt-[18px] inline-flex min-h-[30px] cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-2.5 py-1.5 text-xs font-medium leading-none text-foreground hover:border-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
								onClick={refresh}
								type="button"
							>
								Refresh status
							</button>
						</section>
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
						<section
							aria-labelledby="backup"
							className="rounded-md border border-border bg-card p-5 shadow-card min-[901px]:col-span-full"
						>
							<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
								Data protection
							</p>
							<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance" id="backup">
								Last verified backup
							</h2>
							{board.storage_engine !== "sqlite" ? (
								<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
									Backup verification is managed outside Chirp Cloud for this board.
								</p>
							) : board.last_backup ? (
								<dl className="mt-[18px] mb-0 grid min-[761px]:grid-cols-2 min-[761px]:gap-x-7">
									<div className="grid grid-cols-[minmax(120px,0.65fr)_minmax(0,1fr)] gap-5 border-t border-border py-2.5 max-[460px]:grid-cols-1 max-[460px]:gap-1">
										<dt className="text-subtle">Observed</dt>
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
								<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
									No completed snapshot has been observed yet.
								</p>
							)}
						</section>
					</div>
				</>
			)}
		</DashboardShell>
	);
}
