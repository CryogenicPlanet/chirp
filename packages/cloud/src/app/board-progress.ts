import type { DashboardBoard } from "../dashboard-contract.ts";

const setupSteps = [
	{ checkpoint: "requested", title: "Board requested" },
	{ checkpoint: "storage_configuration_verified", title: "Database configuration checked" },
	{ checkpoint: "app_created", title: "Hosting app created" },
	{ checkpoint: "volume_created", title: "Persistent storage created" },
	{ checkpoint: "machine_created", title: "Board machine created" },
	{ checkpoint: "machine_started", title: "Machine started and health checked" },
	{ checkpoint: "edge_reachable", title: "Secure board address reachable" },
	{ checkpoint: "child_route_observed", title: "Board response verified" },
	{ checkpoint: "provisioned", title: "Ready to open" },
] as const;

export function boardProgress(board: Pick<DashboardBoard, "checkpoint" | "phase">) {
	if (board.phase === "deleting" || board.phase === "deletion_blocked") return null;
	const confirmedIndex = setupSteps.findIndex((step) => step.checkpoint === board.checkpoint);
	return {
		lastConfirmed: setupSteps[confirmedIndex]?.title ?? null,
		steps: setupSteps.map((step, index) => ({
			...step,
			status:
				confirmedIndex < 0
					? "unknown"
					: index <= confirmedIndex
						? "confirmed"
						: index === confirmedIndex + 1
							? "next"
							: "pending",
		})),
	};
}
