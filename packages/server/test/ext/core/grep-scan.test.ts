import { expect, it } from "vitest";
import { scan } from "../../../src/ext/core/grep-scan.ts";
import { smartCase } from "../../../src/ext/core/grep.ts";

const row = (seq: number, body: string, topic = "notes") => ({ seq, topic, agent: "pi", created_at: seq, body });
const options = { pattern: "", fixed: false, ignoreCase: false, context: 0, maxLines: 5, limit: 20 };

it("matches line by line, counts every match and shows context around the first max_lines", () => {
	const body = ["one", "alpha two", "three", "four", "alpha five", "six", "alpha seven"].join("\n");
	expect(scan({ rows: [row(9, body), row(3, "no match here")], options: { ...options, pattern: "^alpha" } })).toEqual({
		ok: true,
		total: 1,
		slow: false,
		hits: [
			{
				seq: 9,
				topic: "notes",
				agent: "pi",
				created_at: 9,
				matched_lines: 3,
				lines: [
					{ line: 2, text: "alpha two", match: true },
					{ line: 5, text: "alpha five", match: true },
					{ line: 7, text: "alpha seven", match: true },
				],
			},
		],
	});
	const near = scan({ rows: [row(9, body)], options: { ...options, pattern: "five", context: 1, maxLines: 1 } });
	expect(near.ok && near.hits[0]?.lines).toEqual([
		{ line: 4, text: "four", match: false },
		{ line: 5, text: "alpha five", match: true },
		{ line: 6, text: "six", match: false },
	]);
	const capped = scan({ rows: [row(9, body)], options: { ...options, pattern: "alpha", maxLines: 1 } });
	expect(capped.ok && capped.hits[0]).toMatchObject({ matched_lines: 3, lines: [{ line: 2 }] });
});

it("keeps newest-first order, limits hits but totals all, and matches fixed text literally", () => {
	const rows = [row(30, "a.b"), row(20, "axb"), row(10, "a.b again")];
	expect(scan({ rows, options: { ...options, pattern: "a.b", limit: 2 } })).toMatchObject({
		total: 3,
		hits: [{ seq: 30 }, { seq: 20 }],
	});
	expect(scan({ rows, options: { ...options, pattern: "a.b", fixed: true } })).toMatchObject({
		total: 2,
		hits: [{ seq: 30 }, { seq: 10 }],
	});
	expect(scan({ rows: [row(1, "(x)[y]{z}")], options: { ...options, pattern: "(x)[y]{", fixed: true } })).toMatchObject(
		{
			total: 1,
		},
	);
});

it("cuts long lines to a window around the match and reports regex syntax errors", () => {
	const long = `${"a".repeat(1000)}needle${"b".repeat(1000)}`;
	const result = scan({ rows: [row(1, long)], options: { ...options, pattern: "needle" } });
	const text = result.ok ? (result.hits[0]?.lines[0]?.text ?? "") : "";
	expect(text).toContain("needle");
	expect(text.startsWith("…") && text.endsWith("…")).toBe(true);
	expect(text.length).toBeLessThanOrEqual(302);
	expect(scan({ rows: [row(1, "x")], options: { ...options, pattern: "(unclosed" } })).toMatchObject({ ok: false });
});

it("uses smart case like ripgrep: uppercase letters count, regex syntax does not", () => {
	expect(smartCase("reading list", false)).toBe(true);
	expect(smartCase("Reading", false)).toBe(false);
	expect(smartCase("\\S+\\W\\bfoo\\D", false)).toBe(true);
	expect(smartCase("\\p{Lu}x", false)).toBe(true);
	expect(smartCase("(?<Name>x)\\k<Name>", false)).toBe(true);
	expect(smartCase("\\S", true)).toBe(false);
	const insensitive = scan({
		rows: [row(1, "Reading List")],
		options: { ...options, pattern: "reading list", ignoreCase: true },
	});
	expect(insensitive).toMatchObject({ total: 1 });
});
