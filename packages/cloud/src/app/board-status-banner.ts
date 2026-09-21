import type { DashboardBoard, DashboardErrorSeverity } from "../dashboard-contract.ts";

export interface BoardStatusBanner {
	readonly severity: DashboardErrorSeverity;
	readonly label: string;
	readonly message: string;
	readonly note: string;
}

export function boardStatusBanner(board: Pick<DashboardBoard, "error">): BoardStatusBanner | null {
	if (!board.error) return null;
	const { code, message, retrying, severity } = board.error;
	if (severity === "progress")
		return {
			severity,
			label: "Setup in progress",
			message,
			note: "A board’s first boot can take a few minutes. Cloud keeps checking until it settles.",
		};
	return {
		severity,
		label: code.replaceAll("_", " "),
		message,
		note: retrying
			? "We’ll retry automatically."
			: "Setup stopped and will not retry on its own. Contact your Cloud administrator for help.",
	};
}
