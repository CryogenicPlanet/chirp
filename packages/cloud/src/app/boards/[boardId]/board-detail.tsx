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
			<main className="auth-main">
				<section className="auth-card">
					<p className="eyebrow">Session required</p>
					<h1>Sign in to view this board.</h1>
					<p className="lede">Cloud access and board access use separate credentials.</p>
					<Link className="button" href="/">
						Go to sign in
					</Link>
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			{error ? (
				<div className="alert alert-error detail-error">
					<p>{error}</p>
					<button className="button-outline compact" onClick={refresh} type="button">
						Try again
					</button>
				</div>
			) : null}
			{!board ? (
				<div aria-label="Loading board" className="detail-skeleton">
					<div className="skeleton skeleton-label" />
					<div className="skeleton skeleton-title" />
					<div className="card skeleton-detail" />
				</div>
			) : (
				<>
					<header className="page-header board-page-header">
						<p className="breadcrumb">
							<Link href="/">Boards</Link> / {board.name}
						</p>
						<div className="title-row">
							<div>
								<h1>{board.name}</h1>
								<p>{board.hostname ?? "A private hostname will appear after provisioning."}</p>
							</div>
							<div className="header-actions">
								<StatusBadge phase={board.phase} />
								{board.hostname ? (
									<a className="button" href={`https://${board.hostname}`} rel="noreferrer" target="_blank">
										Open board
									</a>
								) : null}
							</div>
						</div>
					</header>
					{board.error ? (
						<div className={`alert ${board.error.retrying ? "" : "alert-error"} provisioning-alert`}>
							<p className="section-heading">{board.error.code.replaceAll("_", " ")}</p>
							<p>{board.error.message}</p>
							<p className="muted">
								{board.error.retrying
									? "Provisioning will retry automatically."
									: "Refresh after the underlying issue is resolved. No new operation will be created."}
							</p>
						</div>
					) : null}
					<div className="detail-grid">
						<section aria-labelledby="provisioning" className="card detail-card">
							<p className="section-heading">Provisioning</p>
							<h2 id="provisioning">{checkpointLabels[board.checkpoint] ?? board.checkpoint.replaceAll("_", " ")}</h2>
							<p className="muted">
								{board.phase === "queued" || board.phase === "provisioning"
									? "This page checks for progress every two seconds."
									: board.phase === "ready"
										? "The generated board route has been observed and published."
										: "Provisioning stopped with a persisted error."}
							</p>
							<button className="button-outline compact" onClick={refresh} type="button">
								Refresh status
							</button>
						</section>
						<section aria-labelledby="configuration" className="card detail-card">
							<p className="section-heading">Configuration</p>
							<h2 id="configuration">{storageLabels[board.storage_engine]}</h2>
							<dl className="detail-list">
								<div>
									<dt>Region</dt>
									<dd>{board.region ?? "Pending"}</dd>
								</div>
								{board.storage_engine === "sqlite" ? (
									<div>
										<dt>Persistent volume</dt>
										<dd>{board.volume_size_gb ? `${board.volume_size_gb} GB` : "Pending"}</dd>
									</div>
								) : null}
							</dl>
						</section>
						<section aria-labelledby="backup" className="card detail-card full-width-card">
							<p className="section-heading">Data protection</p>
							<h2 id="backup">Last verified backup</h2>
							{board.storage_engine !== "sqlite" ? (
								<p className="muted">Backup verification is managed outside Chirp Cloud for this board.</p>
							) : board.last_backup ? (
								<dl className="detail-list backup-list">
									<div>
										<dt>Observed</dt>
										<dd>{formatDate(board.last_backup.created_at)}</dd>
									</div>
									<div>
										<dt>Retention reported by provider</dt>
										<dd>{board.last_backup.retention_days} days</dd>
									</div>
									<div>
										<dt>Digest</dt>
										<dd className="mono digest">{board.last_backup.digest}</dd>
									</div>
								</dl>
							) : (
								<p className="muted">No completed snapshot has been observed yet.</p>
							)}
						</section>
					</div>
				</>
			)}
		</DashboardShell>
	);
}
