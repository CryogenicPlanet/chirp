import type { DashboardPhase } from "../dashboard-contract.ts";

const labels: Record<DashboardPhase, string> = {
	queued: "Queued",
	provisioning: "Provisioning",
	ready: "Ready",
	blocked: "Needs attention",
};

const colors: Record<DashboardPhase, string> = {
	queued: "border-[#554f70] bg-accent-surface text-accent-foreground",
	provisioning: "border-[#554f70] bg-accent-surface text-accent-foreground",
	ready: "border-tag-border bg-tag-surface text-tag",
	blocked: "border-warning-border bg-warning-surface text-warning",
};

export function StatusBadge({ phase }: { readonly phase: DashboardPhase }) {
	return (
		<span
			className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-xs border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.02em] ${colors[phase]}`}
		>
			{labels[phase]}
		</span>
	);
}
