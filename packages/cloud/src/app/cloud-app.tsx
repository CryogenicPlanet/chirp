"use client";

import { Schema } from "effect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DashboardBoardResponse, DashboardBoardsResponse, type DashboardBoard } from "../dashboard-contract.ts";
import { AuthButtons } from "./auth-buttons.tsx";
import { type CloudClientUser, DashboardShell } from "./dashboard-shell.tsx";
import { StatusBadge } from "./status-badge.tsx";

const responseError = (status: number) => {
	if (status === 401) return "Your session expired. Sign in again to continue.";
	if (status === 409) return "That request key was already used for different board details.";
	return status >= 500 ? "Chirp Cloud is temporarily unavailable." : "Check the board name and try again.";
};

const storageLabels = { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" } as const;

export function CloudApp({
	authUnavailable,
	sessionUser,
}: {
	readonly authUnavailable: boolean;
	readonly sessionUser: CloudClientUser | null;
}) {
	const router = useRouter();
	const [boards, setBoards] = useState<ReadonlyArray<DashboardBoard>>();
	const [loadError, setLoadError] = useState<string>();
	const [createError, setCreateError] = useState<string>();
	const [creating, setCreating] = useState(false);
	const pendingCreate = useRef<{ readonly key: string; readonly name: string } | undefined>(undefined);

	const load = useCallback((signal?: AbortSignal) => {
		setLoadError(undefined);
		fetch("/api/boards", { cache: "no-store", signal: signal ?? null })
			.then(async (response) => {
				if (!response.ok) throw new Error(responseError(response.status));
				return Schema.decodeUnknownSync(DashboardBoardsResponse)(await response.json()).boards;
			})
			.then(setBoards)
			.catch((error: unknown) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				setLoadError(error instanceof Error ? error.message : "Chirp Cloud is temporarily unavailable.");
			});
	}, []);

	useEffect(() => {
		if (!sessionUser) return;
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load, sessionUser]);

	const create = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const name = form.get("name");
		if (typeof name !== "string") return;
		if (pendingCreate.current?.name !== name) pendingCreate.current = { key: crypto.randomUUID(), name };
		setCreating(true);
		setCreateError(undefined);
		fetch("/api/boards", {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": pendingCreate.current.key },
			body: JSON.stringify({ name }),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(responseError(response.status));
				return Schema.decodeUnknownSync(DashboardBoardResponse)(await response.json()).board;
			})
			.then((board) => {
				pendingCreate.current = undefined;
				router.push(`/boards/${encodeURIComponent(board.id)}`);
			})
			.catch((error: unknown) =>
				setCreateError(error instanceof Error ? error.message : "The board could not be created."),
			)
			.finally(() => setCreating(false));
	};

	if (!sessionUser)
		return (
			<main className="auth-main">
				<section className="auth-card">
					<p className="eyebrow">Chirp Cloud</p>
					<h1>Private boards, managed quietly.</h1>
					<p className="lede">Create and provision a managed Chirp board from one secure account.</p>
					{authUnavailable ? (
						<p className="alert alert-error auth-alert">
							Your current session could not be checked. Authentication is temporarily unavailable.
						</p>
					) : null}
					<AuthButtons />
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			<header className="page-header">
				<p className="breadcrumb">Cloud / boards</p>
				<h1>Your boards</h1>
				<p>Private managed boards owned by {sessionUser.email}.</p>
			</header>
			<section aria-labelledby="create-board" className="card create-card">
				<div>
					<p className="section-heading">New board</p>
					<h2 id="create-board">Name and deploy</h2>
					<p className="muted">A managed SQLite board in the default region.</p>
				</div>
				<form className="create-form" onSubmit={create}>
					<label htmlFor="board-name">Private board name</label>
					<div className="form-row">
						<input id="board-name" maxLength={80} name="name" placeholder="Research notes" required />
						<button disabled={creating} type="submit">
							{creating ? "Queuing…" : "Create board"}
						</button>
					</div>
					{createError ? (
						<p aria-live="polite" className="alert alert-error">
							{createError}
						</p>
					) : null}
				</form>
			</section>
			<section aria-labelledby="board-list" className="board-section">
				<div className="section-row">
					<h2 className="section-heading" id="board-list">
						Boards
					</h2>
					<button className="button-ghost compact" onClick={() => load()} type="button">
						Refresh
					</button>
				</div>
				{loadError ? (
					<div className="alert alert-error">
						<p>{loadError}</p>
						<button className="button-outline compact" onClick={() => load()} type="button">
							Try again
						</button>
					</div>
				) : null}
				{!boards ? (
					<div aria-label="Loading boards" className="board-grid">
						<div className="card board-card skeleton-card" />
						<div className="card board-card skeleton-card" />
					</div>
				) : boards.length === 0 ? (
					<div className="empty-state">
						<h2>No boards yet</h2>
						<p>Name your first board above. Provisioning starts automatically.</p>
					</div>
				) : (
					<div className="board-grid">
						{boards.map((board) => (
							<article className="card board-card" key={board.id}>
								<div className="board-card-heading">
									<div>
										<h2>{board.name}</h2>
										<p className="mono muted">
											{storageLabels[board.storage_engine]} · {new Date(board.created_at).toLocaleDateString()}
										</p>
									</div>
									<StatusBadge phase={board.phase} />
								</div>
								<p className="checkpoint">{board.checkpoint.replaceAll("_", " ")}</p>
								<div className="card-actions">
									<Link className="button-outline" href={`/boards/${encodeURIComponent(board.id)}`}>
										View details
									</Link>
									{board.hostname ? (
										<a className="button-link" href={`https://${board.hostname}`} rel="noreferrer" target="_blank">
											Open board
										</a>
									) : null}
								</div>
							</article>
						))}
					</div>
				)}
			</section>
		</DashboardShell>
	);
}
