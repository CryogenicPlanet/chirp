import type { DashboardPhase } from "../dashboard-contract.ts";

const labels: Record<DashboardPhase, string> = {
	queued: "Queued",
	provisioning: "Provisioning",
	ready: "Ready",
	blocked: "Needs attention",
	deleting: "Deleting",
	deletion_blocked: "Deletion needs attention",
};

// Leaf for ready, danger for anything stopped, slate while work is still running.
const tones: Record<DashboardPhase, string> = {
	queued: "text-slate",
	provisioning: "text-slate",
	ready: "text-leaf",
	blocked: "text-danger",
	deleting: "text-slate",
	deletion_blocked: "text-danger",
};

export function StatusBadge({ phase }: { readonly phase: DashboardPhase }) {
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1.5 text-[13px] leading-6 font-medium whitespace-nowrap ${tones[phase]}`}
		>
			<span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
			{labels[phase]}
		</span>
	);
}
