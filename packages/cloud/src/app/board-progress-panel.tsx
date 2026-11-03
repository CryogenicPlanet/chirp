"use client";

import { AlertTriangle, Check, Circle, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { DashboardBoard } from "../dashboard-contract.ts";
import { boardProgress } from "./board-progress.ts";
import { Button } from "./components/ui/button.tsx";

const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const issueMarks = {
	progress: "bg-card text-ink ring-1 ring-ink",
	warning: "bg-danger/6 text-danger ring-1 ring-danger/40",
	error: "bg-danger text-white",
} as const;

const issueText = {
	progress: "text-slate",
	warning: "text-danger",
	error: "text-danger",
} as const;

export function BoardProgressPanel({
	board,
	className,
	onRefresh,
}: {
	readonly board: DashboardBoard;
	/** The container comes from the parent: a card of its own, or a section inside the technical details. */
	readonly className: string;
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
		<section aria-labelledby="provisioning" className={className}>
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="m-0 text-[13.5px] font-medium text-slate">{deleting ? "Deletion" : "Setup progress"}</p>
					<h2 className="mt-1 mb-0 text-[19px] leading-tight font-[650] tracking-[-0.02em]" id="provisioning">
						{title}
					</h2>
				</div>
				<Button aria-label="Refresh status" variant="ghost" size="icon-sm" onClick={onRefresh}>
					<RefreshCw aria-hidden="true" />
				</Button>
			</div>
			{deleting ? (
				<p className="mt-3 mb-0 text-[14.5px] leading-[1.55] text-slate">
					{stopped
						? "After your administrator resolves the issue, choose Retry deletion."
						: "Cloud is checking and removing your board’s hosting resources. This page will close when deletion is confirmed."}{" "}
					External databases are kept. Detailed deletion steps are not yet recorded.
				</p>
			) : (
				<>
					<p className="mt-3 mb-5 text-[14.5px] leading-[1.55] text-slate">
						{progress.lastConfirmed ? (
							<>
								Last confirmed: <span className="text-ink">{progress.lastConfirmed}.</span>
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
								<div className="absolute top-6 bottom-0 left-[11px] w-px bg-rule" />
								<span
									className={`relative grid size-6 shrink-0 place-items-center rounded-full ${step.status === "confirmed" ? "bg-leaf text-white" : step.issue ? issueMarks[step.issue.severity] : step.status === "next" ? "bg-card text-ink ring-1 ring-ink" : "bg-card text-slate ring-1 ring-edge"}`}
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
										className={`m-0 text-[14.5px] ${step.status === "pending" || step.status === "unknown" ? "text-slate" : "font-medium text-ink"}`}
									>
										{step.title}
									</p>
									<p className="mt-0.5 mb-0 text-[13px] text-slate">
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
											<p className={`mt-1 mb-0 text-[13.5px] leading-[1.5] ${issueText[step.issue.severity]}`}>
												{step.issue.message}
											</p>
											{step.issue.anchored ? null : (
												<p className="mt-1 mb-0 text-[13px] leading-[1.5] text-slate">
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
				<p className="mt-4 mb-0 text-[13.5px] text-slate">
					Eligible to retry after {formatDate(board.operation.next_attempt_at)}.
				</p>
			) : null}
			<details className="mt-5 border-t border-rule pt-4">
				<summary className="w-fit cursor-pointer rounded-md text-[13.5px] font-medium text-slate hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
					Diagnostic details
				</summary>
				<p className="mt-3 mb-3 text-[13px] text-slate">
					{board.operation ? `Last operation update: ${formatDate(board.operation.updated_at)}. ` : ""}Individual step
					times are not recorded.
				</p>
				<pre className="mt-0 mb-3 overflow-x-auto rounded-xl bg-wash p-3.5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-ink ring-1 ring-rule [overflow-wrap:anywhere]">
					{diagnostics}
				</pre>
				<Button variant="outline" size="sm" onClick={() => void copy()}>
					<Copy aria-hidden="true" />
					Copy details
				</Button>
				<span role="status" className="ml-2 text-[13px] text-slate">
					{copyStatus}
				</span>
			</details>
		</section>
	);
}
