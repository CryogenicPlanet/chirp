import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Aggregated topic reads must equal the per-topic correlated reads they replaced, on randomized boards
// with ancestor and root marks, archived and deleted subtrees, deleted messages and unpublished images.
const run = async (engine: string) => {
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "../../fixtures/topic-read-equivalence.ts"), engine],
		{ timeout: 110000 },
	);
	expect(result.stdout).toContain("TOPIC_READ_EQUIVALENCE_VERIFIED");
};
it.for(["sqlite", "pglite"])("%s topic rollups match the correlated reference", { timeout: 120000 }, run);
const native = process.env.COMMS_TEST_ENGINE;
it.skipIf((native !== "pg" && native !== "mysql") || !process.env.COMMS_TEST_STORE_CONFIG)(
	"native topic rollups match the correlated reference",
	() => run(native ?? ""),
	120000,
);
