/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("private setup codes expire, rotate, consume once and close after setup", async ({ onTestFinished }) => {
	const directory = await mkdtemp("/tmp/chirp-setup-");
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const result = await promisify(execFile)(
		"bun",
		[join(import.meta.dirname, "fixtures/setup-code-run.ts"), directory],
		{ timeout: 30_000 },
	);
	expect(result.stdout).toContain("setup code scenario passed");
}, 35_000);
