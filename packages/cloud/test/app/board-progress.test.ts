import { describe, expect, test } from "vitest";
import { boardProgress } from "../../src/app/board-progress.ts";

const failure = (code: string) => ({ code, message: `${code} reported`, retrying: false, severity: "error" }) as const;

describe("board progress evidence", () => {
	test("preserves completed work when setup blocks after machine creation", () => {
		const progress = boardProgress({ phase: "blocked", checkpoint: "machine_created", error: null });
		expect(progress?.lastConfirmed).toBe("Board machine created");
		expect(progress?.steps.filter((step) => step.status === "confirmed")).toHaveLength(5);
		expect(progress?.steps.find((step) => step.status === "next")?.checkpoint).toBe("machine_started");
		expect(progress?.steps.find((step) => step.checkpoint === "edge_reachable")?.status).toBe("pending");
	});
	test("does not invent completed work for an unknown legacy checkpoint", () => {
		const progress = boardProgress({ phase: "blocked", checkpoint: "blocked", error: null });
		expect(progress?.lastConfirmed).toBeNull();
		expect(progress?.steps.every((step) => step.status === "unknown")).toBe(true);
		expect(progress?.steps.every((step) => step.issue === null)).toBe(true);
	});
	test("does not interpret deletion checkpoints as provisioning progress", () => {
		expect(boardProgress({ phase: "deleting", checkpoint: "requested", error: null })).toBeNull();
		expect(boardProgress({ phase: "deletion_blocked", checkpoint: "requested", error: null })).toBeNull();
	});
	test("marks all stages confirmed only after the final checkpoint", () => {
		const progress = boardProgress({ phase: "ready", checkpoint: "provisioned", error: null });
		expect(progress?.steps.every((step) => step.status === "confirmed")).toBe(true);
	});
	test("anchors an error that names its resource to that step", () => {
		const progress = boardProgress({
			phase: "blocked",
			checkpoint: "machine_created",
			error: failure("machine_start_ambiguous"),
		});
		const carrying = progress?.steps.filter((step) => step.issue !== null) ?? [];
		expect(carrying).toHaveLength(1);
		expect(carrying[0]?.checkpoint).toBe("machine_started");
		expect(carrying[0]?.issue).toMatchObject({ severity: "error", anchored: true });
	});
	test("keeps an error about an already confirmed resource on that resource's step", () => {
		const progress = boardProgress({
			phase: "blocked",
			checkpoint: "machine_created",
			error: failure("volume_create_ambiguous"),
		});
		const carrying = progress?.steps.find((step) => step.issue !== null);
		expect(carrying?.checkpoint).toBe("volume_created");
		expect(carrying?.status).toBe("confirmed");
		expect(carrying?.issue?.anchored).toBe(true);
	});
	test("moves an unreachable board to whichever HTTPS probe is still unconfirmed", () => {
		const health = boardProgress({
			phase: "provisioning",
			checkpoint: "machine_started",
			error: failure("edge_unavailable"),
		});
		expect(health?.steps.find((step) => step.issue !== null)?.checkpoint).toBe("edge_reachable");
		const childRoute = boardProgress({
			phase: "provisioning",
			checkpoint: "edge_reachable",
			error: failure("edge_unavailable"),
		});
		expect(childRoute?.steps.find((step) => step.issue !== null)?.checkpoint).toBe("child_route_observed");
	});
	test("leaves a code that any step can raise on the next unconfirmed step and says so", () => {
		const progress = boardProgress({
			phase: "blocked",
			checkpoint: "volume_created",
			error: failure("retry_exhausted"),
		});
		const carrying = progress?.steps.find((step) => step.issue !== null);
		expect(carrying?.checkpoint).toBe("machine_created");
		expect(carrying?.status).toBe("next");
		expect(carrying?.issue?.anchored).toBe(false);
	});
});
