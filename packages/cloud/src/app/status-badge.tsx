import type { DashboardPhase } from "../dashboard-contract.ts";

const labels: Record<DashboardPhase, string> = {
	queued: "Queued",
	provisioning: "Provisioning",
	ready: "Ready",
	blocked: "Needs attention",
};

export function StatusBadge({ phase }: { readonly phase: DashboardPhase }) {
	return <span className={`badge badge-${phase}`}>{labels[phase]}</span>;
}
