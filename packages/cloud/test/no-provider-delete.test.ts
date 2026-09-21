import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("provider deletion source tripwire", () => {
	test("keeps provider deletion confined to its explicit worker capability", async () => {
		const root = join(import.meta.dirname, "../src");
		const files = (await readdir(root, { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
			.map((entry) => join(entry.parentPath, entry.name));
		const forbidden = /\b(?:deleteApp|deleteMachine|deleteVolume|deleteSecret|releaseIp)\b|(?:request|make)\("DELETE"/;
		const violations: string[] = [];
		for (const file of files) {
			if (file.endsWith("/fly-deletion-api.ts")) continue;
			if (forbidden.test(await readFile(file, "utf8"))) violations.push(file.slice(root.length + 1));
		}
		expect(violations).toEqual([]);
	});
});
