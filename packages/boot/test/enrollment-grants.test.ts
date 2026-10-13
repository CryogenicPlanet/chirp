import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

// Held enrollments back extension grants: boot keeps the only credential and the app names its family.
for (const scenario of ["lifecycle", "lapse", "older-image"]) {
	test(`extension grant enrollment: ${scenario}`, async ({ onTestFinished }) => {
		const directory = await mkdtemp(join(tmpdir(), "comms-grants-"));
		onTestFinished(() => rm(directory, { recursive: true, force: true }));
		const result = await promisify(execFile)(
			"bun",
			[join(import.meta.dirname, "fixtures/enrollment-grants-run.ts"), join(directory, "boot.db"), scenario],
			{ timeout: 20000 },
		);
		expect(result.stdout).toContain("grant scenario passed");
	}, 25000);
}
