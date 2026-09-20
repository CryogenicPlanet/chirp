"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { DashboardBoardResponse, DashboardBoardsResponse, type DashboardBoard } from "../dashboard-contract.ts";
import { AuthButtons } from "./auth-buttons.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "./dashboard-response.ts";
import { type CloudClientUser, DashboardShell } from "./dashboard-shell.tsx";
import { StatusBadge } from "./status-badge.tsx";

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
			.then((response) => readDashboardResponse(response, DashboardBoardsResponse))
			.then(({ boards }) => boards)
			.then(setBoards)
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
			.then((response) => readDashboardResponse(response, DashboardBoardResponse))
			.then(({ board }) => {
				pendingCreate.current = undefined;
				router.push(`/boards/${encodeURIComponent(board.id)}`);
			})
			.catch((error: unknown) => setCreateError(dashboardErrorMessage(error)))
			.finally(() => setCreating(false));
	};

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
					<AuthButtons />
				</section>
			</main>
		);

	return (
		<DashboardShell user={sessionUser}>
			<header className="mb-7">
				<p className="mt-0 mb-2 font-mono text-[11px] tracking-[0.03em] text-subtle">Cloud / boards</p>
				<h1 className="m-0 text-3xl font-normal tracking-[-0.035em] text-balance max-[760px]:text-2xl">Your boards</h1>
				<p className="mt-2 mb-0 leading-normal text-muted-foreground [overflow-wrap:anywhere]">
					Private managed boards owned by {sessionUser.email}.
				</p>
			</header>
			<section
				aria-labelledby="create-board"
				className="grid items-end gap-5 rounded-md border border-border bg-card p-5 shadow-card min-[901px]:grid-cols-[minmax(180px,0.65fr)_minmax(300px,1fr)] min-[901px]:gap-7"
			>
				<div>
					<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">New board</p>
					<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance" id="create-board">
						Name and deploy
					</h2>
					<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
						A managed SQLite board in the default region.
					</p>
				</div>
				<form className="grid gap-[7px]" onSubmit={create}>
					<label className="grid text-xs font-medium" htmlFor="board-name">
						Private board name
					</label>
					<div className="flex gap-2 max-[460px]:grid">
						<input
							className="min-h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground placeholder:text-placeholder focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							id="board-name"
							maxLength={80}
							name="name"
							placeholder="Research notes"
							required
						/>
						<button
							className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground hover:not-disabled:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
							disabled={creating}
							type="submit"
						>
							{creating ? "Queuing…" : "Create board"}
						</button>
					</div>
					{createError ? (
						<p
							aria-live="polite"
							className="mt-[5px] rounded-md border border-destructive-border bg-destructive-surface px-4 py-3.5 text-xs leading-[1.55] text-destructive"
						>
							{createError}
						</p>
					) : null}
				</form>
			</section>
			<section aria-labelledby="board-list" className="mt-8">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase" id="board-list">
						Boards
					</h2>
					<button
						className="inline-flex min-h-[30px] cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-xs font-medium leading-none text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						onClick={() => load()}
						type="button"
					>
						Refresh
					</button>
				</div>
				{loadError ? (
					<div className="rounded-md border border-destructive-border bg-destructive-surface px-4 py-3.5 text-xs leading-[1.55] text-destructive">
						<p className="m-0">{loadError}</p>
						<button
							className="mt-2.5 inline-flex min-h-[30px] cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-2.5 py-1.5 text-xs font-medium leading-none text-foreground hover:border-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
							onClick={() => load()}
							type="button"
						>
							Try again
						</button>
					</div>
				) : null}
				{!boards && loadError ? null : !boards ? (
					<div aria-label="Loading boards" className="grid gap-3 min-[761px]:grid-cols-2">
						<div className="min-h-[170px] animate-pulse rounded-md border border-border bg-card shadow-card motion-reduce:animate-none" />
						<div className="min-h-[170px] animate-pulse rounded-md border border-border bg-card shadow-card motion-reduce:animate-none" />
					</div>
				) : boards.length === 0 ? (
					<div className="rounded-md border border-dashed border-input px-6 py-10 text-center">
						<h2 className="mt-[7px] mb-0 text-lg leading-tight font-normal text-balance">No boards yet</h2>
						<p className="mt-1.5 mb-0 leading-normal text-muted-foreground">
							Name your first board above. Provisioning starts automatically.
						</p>
					</div>
				) : (
					<div className="grid gap-3 min-[761px]:grid-cols-2">
						{boards.map((board) => (
							<article
								className="grid min-h-[168px] gap-4 rounded-md border border-border bg-card p-[18px] shadow-card"
								key={board.id}
							>
								<div className="flex items-start justify-between gap-3">
									<div>
										<h2 className="m-0 text-lg leading-tight font-normal text-balance [overflow-wrap:anywhere]">
											{board.name}
										</h2>
										<p className="mt-1.5 mb-0 font-mono text-[10px] text-muted-foreground">
											{storageLabels[board.storage_engine]} · {new Date(board.created_at).toLocaleDateString()}
										</p>
									</div>
									<StatusBadge phase={board.phase} />
								</div>
								<p className="m-0 text-[13px] text-muted-foreground capitalize">
									{board.checkpoint.replaceAll("_", " ")}
								</p>
								<div className="flex flex-wrap items-center self-end gap-1.5">
									<Link
										className="inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-3.5 py-2 text-[13px] font-medium leading-none text-foreground no-underline hover:border-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										href={`/boards/${encodeURIComponent(board.id)}`}
									>
										View details
									</Link>
									{board.hostname ? (
										<a
											className="inline-flex min-h-9 items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-transparent px-3.5 py-2 text-[13px] font-medium leading-none text-muted-foreground no-underline hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
											href={`https://${board.hostname}`}
											rel="noreferrer"
											target="_blank"
										>
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
