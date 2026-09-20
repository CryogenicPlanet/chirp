import { describe, expect, test } from "vitest";
import { createDashboardBoard, getDashboardBoard, listDashboardBoards } from "../src/dashboard-runtime.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { realPostgres, runFresh } from "./fixture.ts";

describe("dashboard request runtime", () => {
	test.skipIf(!realPostgres)("builds and releases a scoped PostgreSQL layer per request", async () => {
		await runFresh(migrateCloudDatabase);
		const created = await createDashboardBoard("user-1", {
			name: "Runtime board",
			idempotency_key: "runtime-create",
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect((await listDashboardBoards("user-1")).map(({ id }) => id)).toEqual([created.board.id]);
		const detail = await getDashboardBoard("user-1", created.board.id);
		expect(detail._tag).toBe("Some");
	});
});
