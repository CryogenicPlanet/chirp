"use client";

import { AlertTriangle, Check, Circle, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { DashboardBoard } from "../dashboard-contract.ts";
import { boardProgress } from "./board-progress.ts";
import { Button } from "./components/ui/button.tsx";

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const issueMarks = {
	progress: "border-[#554f70] bg-accent-surface text-accent-foreground",
	warning: "border-warning-border bg-warning-surface text-warning",
	error: "border-destructive-border bg-destructive-surface text-destructive",
} as const;

const issueText = {
	progress: "text-muted-foreground",
	warning: "text-warning",
	error: "text-destructive",
} as const;

export function BoardProgressPanel({
	board,
	onRefresh,
}: {
	readonly board: DashboardBoard;
	readonly onRefresh: () => void;
}) {
	const [copyStatus, setCopyStatus] = useState("");
	const progress = boardProgress(board);
	const deleting = progress === null;
	const stopped = board.phase === "blocked" || board.phase === "deletion_blocked";
	const title = deleting
		? stopped
			? "Deletion needs attention"
			: "Deleting your board"
		: board.phase === "ready"
			? "Your board is ready"
			: stopped
				? "Setup stopped"
				: board.phase === "queued"
					? "Waiting to start"
					: "Setting up your board";
	const diagnostics = [
		`Board: ${board.id}`,
		`Status: ${board.phase}`,
		`Last recorded checkpoint: ${board.checkpoint}`,
		`Requested: ${board.created_at}`,
		...(board.operation
			? [
					`Operation: ${board.operation.id}`,
					`Operation state: ${board.operation.state}`,
					`Attempt: ${board.operation.attempt}`,
					`Last operation update: ${board.operation.updated_at}`,
				]
			: []),
		...(board.error ? [`Error: ${board.error.code}`, board.error.message] : []),
	].join("\n");
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(diagnostics);
			setCopyStatus("Copied");
		} catch {
			setCopyStatus("Couldn't copy. Select the details below.");
		}
	};
	return (
		<section aria-labelledby="provisioning" className="rounded-md border border-border bg-card p-5 shadow-card">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">
						{deleting ? "Deletion" : "Setup progress"}
					</p>
					<h2 className="mt-2 mb-0 text-lg leading-tight font-normal" id="provisioning">
						{title}
					</h2>
				</div>
				<Button aria-label="Refresh status" variant="ghost" size="icon-sm" onClick={onRefresh}>
					<RefreshCw aria-hidden="true" />
				</Button>
			</div>
			{deleting ? (
				<p className="mt-3 text-sm leading-relaxed text-muted-foreground">
					{stopped
						? "After your administrator resolves the issue, choose Retry deletion."
						: "Cloud is checking and removing your board’s hosting resources. This page will close when deletion is confirmed."}{" "}
					External databases are kept. Detailed deletion steps are not yet recorded.
				</p>
			) : (
				<>
					<p className="mt-3 mb-5 text-sm leading-relaxed text-muted-foreground">
						{progress.lastConfirmed ? (
							<>
								Last confirmed: <span className="text-foreground">{progress.lastConfirmed}.</span>
							</>
						) : (
							"No setup checkpoint is available yet."
						)}{" "}
						{stopped
							? "Setup will not continue on its own. An administrator has to resolve the issue and resume it."
							: board.phase !== "ready"
								? "You can leave this page and come back."
								: "Open your board to continue."}
					</p>
					<ol className="m-0 list-none p-0">
						{progress.steps.map((step) => (
							<li key={step.checkpoint} className="relative flex gap-3 pb-5 last:pb-0">
								<div className="absolute top-6 bottom-0 left-[11px] w-px bg-border" />
								<span
									className={`relative grid size-6 shrink-0 place-items-center rounded-full border ${step.status === "confirmed" ? "border-primary/25 bg-primary/10 text-primary" : step.issue ? issueMarks[step.issue.severity] : step.status === "next" ? "border-[#554f70] bg-accent-surface text-accent-foreground" : "border-border text-subtle"}`}
								>
									{step.status === "confirmed" ? (
										<Check className="size-3.5" aria-hidden="true" />
									) : step.issue && step.issue.severity !== "progress" ? (
										<AlertTriangle className="size-3.5" aria-hidden="true" />
									) : (
										<Circle className="size-2" aria-hidden="true" />
									)}
								</span>
								<div className="min-w-0 pt-0.5">
									<p
										className={`m-0 text-sm ${step.status === "pending" || step.status === "unknown" ? "text-subtle" : "text-foreground"}`}
									>
										{step.title}
									</p>
									<p className="mt-0.5 mb-0 text-xs text-muted-foreground">
										{step.status === "confirmed"
											? "Confirmed"
											: step.status === "next"
												? "Next unconfirmed step"
												: step.status === "unknown"
													? "Status unavailable"
													: "Pending"}
									</p>
									{step.issue ? (
										<>
											<p className={`mt-1 mb-0 text-xs leading-relaxed ${issueText[step.issue.severity]}`}>
												{step.issue.message}
											</p>
											{step.issue.anchored ? null : (
												<p className="mt-1 mb-0 text-xs leading-relaxed text-subtle">
													Latest reported failure. A retry can fail while rechecking an earlier step, so this is not
													necessarily where it failed.
												</p>
											)}
										</>
									) : null}
								</div>
							</li>
						))}
					</ol>
				</>
			)}
			{board.operation?.next_attempt_at && board.error?.retrying ? (
				<p className="mt-4 text-xs text-muted-foreground">
					Eligible to retry after {formatDate(board.operation.next_attempt_at)}.
				</p>
			) : null}
			<details className="mt-5 border-t border-border pt-4">
				<summary className="cursor-pointer text-xs text-muted-foreground">Diagnostic details</summary>
				<p className="mt-3 text-xs text-subtle">
					{board.operation ? `Last operation update: ${formatDate(board.operation.updated_at)}. ` : ""}Individual step
					times are not recorded.
				</p>
				<pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
					{diagnostics}
				</pre>
				<Button variant="outline" size="sm" onClick={() => void copy()}>
					<Copy aria-hidden="true" />
					Copy details
				</Button>
				<span role="status" className="ml-2 text-xs text-muted-foreground">
					{copyStatus}
				</span>
			</details>
		</section>
	);
}
