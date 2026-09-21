import type { DashboardBoard, DashboardErrorSeverity } from "../dashboard-contract.ts";

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

type SetupCheckpoint = (typeof setupSteps)[number]["checkpoint"];

// A code that names the resource it is about belongs to that resource's step. Provisioning re-verifies
// every earlier recorded resource on each attempt, so such a failure can belong to a step that is
// already confirmed; that is exactly why the code, not the timeline position, decides the step.
// `edge_unavailable` covers both HTTPS probes, so it takes the first of those two steps that is not
// confirmed yet. Codes that any step can raise are left out and fall back to the next unconfirmed step.
const codeCheckpoints: readonly {
	readonly codes: readonly string[];
	readonly checkpoints: readonly SetupCheckpoint[];
}[] = [
	{
		codes: ["storage_configuration_unsupported", "postgres_configuration_failed", "postgres_secrets_failed"],
		checkpoints: ["storage_configuration_verified"],
	},
	{ codes: ["app_create_ambiguous"], checkpoints: ["app_created"] },
	{ codes: ["volume_create_ambiguous"], checkpoints: ["volume_created"] },
	{ codes: ["machine_create_ambiguous"], checkpoints: ["machine_created"] },
	{ codes: ["machine_start_ambiguous"], checkpoints: ["machine_started"] },
	{
		codes: ["edge_ip_ambiguous", "edge_certificate_ambiguous", "edge_a_record_ambiguous", "edge_txt_record_ambiguous"],
		checkpoints: ["edge_reachable"],
	},
	{ codes: ["edge_unavailable"], checkpoints: ["edge_reachable", "child_route_observed"] },
];

export interface BoardProgressIssue {
	readonly severity: DashboardErrorSeverity;
	readonly message: string;
	// False when the code does not name a step: the issue then sits on the next unconfirmed step, which
	// is not evidence that setup failed there.
	readonly anchored: boolean;
}

const stepIndex = (checkpoint: string) => setupSteps.findIndex((step) => step.checkpoint === checkpoint);

const anchoredIndex = (code: string, confirmedIndex: number) => {
	const entry = codeCheckpoints.find((candidate) => candidate.codes.includes(code));
	if (!entry) return -1;
	const indexes = entry.checkpoints.map(stepIndex);
	return indexes.find((index) => index > confirmedIndex) ?? indexes[indexes.length - 1] ?? -1;
};

export function boardProgress(board: Pick<DashboardBoard, "checkpoint" | "phase" | "error">) {
	if (board.phase === "deleting" || board.phase === "deletion_blocked") return null;
	const confirmedIndex = stepIndex(board.checkpoint);
	const error = board.error;
	const anchored = error ? anchoredIndex(error.code, confirmedIndex) : -1;
	const nextIndex = confirmedIndex >= 0 && confirmedIndex + 1 < setupSteps.length ? confirmedIndex + 1 : -1;
	const issueIndex = anchored >= 0 ? anchored : error ? nextIndex : -1;
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
			issue:
				error && index === issueIndex
					? ({ severity: error.severity, message: error.message, anchored: anchored >= 0 } satisfies BoardProgressIssue)
					: null,
		})),
	};
}
