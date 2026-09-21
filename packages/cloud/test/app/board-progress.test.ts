import { describe, expect, test } from "vitest";
import { boardProgress } from "../../src/app/board-progress.ts";

describe("board progress evidence", () => {
	test("preserves completed work when setup blocks after machine creation", () => {
		const progress = boardProgress({ phase: "blocked", checkpoint: "machine_created" });
		expect(progress?.lastConfirmed).toBe("Board machine created");
		expect(progress?.steps.filter((step) => step.status === "confirmed")).toHaveLength(5);
		expect(progress?.steps.find((step) => step.status === "next")?.checkpoint).toBe("machine_started");
		expect(progress?.steps.find((step) => step.checkpoint === "edge_reachable")?.status).toBe("pending");
	});
	test("does not invent completed work for an unknown legacy checkpoint", () => {
		const progress = boardProgress({ phase: "blocked", checkpoint: "blocked" });
		expect(progress?.lastConfirmed).toBeNull();
		expect(progress?.steps.every((step) => step.status === "unknown")).toBe(true);
	});
	test("does not interpret deletion checkpoints as provisioning progress", () => {
		expect(boardProgress({ phase: "deleting", checkpoint: "requested" })).toBeNull();
		expect(boardProgress({ phase: "deletion_blocked", checkpoint: "requested" })).toBeNull();
	});
	test("marks all stages confirmed only after the final checkpoint", () => {
		const progress = boardProgress({ phase: "ready", checkpoint: "provisioned" });
		expect(progress?.steps.every((step) => step.status === "confirmed")).toBe(true);
	});
});
