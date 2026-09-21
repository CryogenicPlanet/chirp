import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("provider deletion source tripwire", () => {
	test("flags known deletion names and literal DELETE requests in src", async () => {
		const root = join(import.meta.dirname, "../src");
		const files = (await readdir(root, { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
			.map((entry) => join(entry.parentPath, entry.name));
		const forbidden = /\b(?:deleteApp|deleteMachine|deleteVolume|deleteSecret|releaseIp)\b|request\("DELETE"/;
		const violations: string[] = [];
		for (const file of files) {
			if (forbidden.test(await readFile(file, "utf8"))) violations.push(file.slice(root.length + 1));
		}
		expect(violations).toEqual([]);
	});
});
