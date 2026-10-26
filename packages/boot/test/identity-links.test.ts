/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

for (const scenario of ["refusals", "stall", "discovery", "assertions", "concurrency", "restart", "setup"]) {
	test(`GitHub and Google identities: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-identity-links-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/identity-links.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 40_000 },
		);
		expect(result.stdout).toContain("identity links scenario passed");
	}, 45_000);
}
