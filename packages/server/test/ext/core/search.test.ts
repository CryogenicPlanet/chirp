import { KernelError } from "../../../src/kernel/boot-channel.ts";
import { Effect, Schema } from "effect";
import { Statement } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { searchMessages, wordForms } from "../../../src/ext/core/search.ts";

const constructor = (dialect: "sqlite" | "pg" | "mysql") =>
	Statement.make(
		Effect.die("Compile only"),
		Statement.makeCompiler({
			dialect,
			placeholder: (index) => (dialect === "pg" ? `$${index}` : "?"),
			onIdentifier: (value) => `"${value.replaceAll('"', '""')}"`,
			onRecordUpdate: () => {
				throw new Error("Unused record helper");
			},
			onCustom: () => {
				throw new Error("Unused custom helper");
			},
		}),
		[],
		undefined,
	);

it("keeps caller search operators bound and selects the published image on every engine", async () => {
	for (const name of ["sqlite", "pg", "mysql"] as const) {
		const sql = constructor(name);
		const fragment = await Effect.runPromise(searchMessages(sql, 'alpha OR -beta "blue the moon"', 42));
		const [text, values] = sql`SELECT id FROM visible_messages WHERE ${fragment}`.compile();
		expect(text).not.toContain("alpha");
		expect(text).not.toContain("blue");
		expect(text).toContain("updated_seq<=");
		expect(text).toContain("updated_seq>");
		expect(values.filter((value) => value === 42)).toHaveLength(2);
		if (name === "sqlite") {
			expect(values).toContain('body : (("alpha" OR "alphas") AND "OR" AND "-beta" AND "blue the moon")');
			expect(values).toContain('previous_body : (("alpha" OR "alphas") AND "OR" AND "-beta" AND "blue the moon")');
		} else if (name === "pg") {
			expect(text).toContain("body_tsv @@");
			expect(text).toContain("previous_body_tsv @@");
			expect(text).toContain("phraseto_tsquery('simple'");
			expect(text).toContain("plainto_tsquery('simple'");
			expect(text).not.toContain("websearch_to_tsquery");
			expect(values).toContain("OR");
			expect(values).toContain("-beta");
			expect(values).toContain("alphas");
		} else {
			expect(text).toContain("MATCH(body) AGAINST");
			expect(text).toContain("MATCH(previous_body) AGAINST");
			expect(values).toContain('+("alpha" "alphas") +"OR" +"beta" +"blue the moon"');
		}
	}
});

it("adds an English word's regular singular or plural and leaves everything else as typed", () => {
	for (const [word, ...forms] of [
		["list", "lists"],
		["lists", "list"],
		["Notes", "Note"],
		["cases", "case"],
		["boxes", "box", "boxe"],
		["sizes", "siz", "size"],
		["classes", "class", "classe"],
		["class", "classes"],
		["status", "statuses"],
		["policy", "policies"],
		["movies", "movy", "movie"],
		["days", "day"],
		["match", "matches"],
	])
		expect(wordForms(word ?? "")).toEqual([word, ...forms]);
	for (const part of ["its", "has", "OR", "café", "дом", "v2", "-beta", "reading-list", "foo@bar.com", '"lists"'])
		expect(wordForms(part)).toEqual([part]);
});

it("searches a hyphen-joined word as written or as the phrase of its parts on PostgreSQL", async () => {
	const sql = constructor("pg");
	const fragment = await Effect.runPromise(searchMessages(sql, 'reading-list "lists" -beta', 42));
	const [text, values] = sql`SELECT id FROM visible_messages WHERE ${fragment}`.compile();
	expect(values).toContain("reading list");
	expect(values).toContain("reading-list");
	expect(values).toContain("lists");
	expect(values).not.toContain("list");
	expect(values).toContain("-beta");
	expect(text.match(/phraseto_tsquery/g)).toHaveLength(4);
	const mysql = constructor("mysql");
	const config = { minimum: 3, maximum: 84, stopwords: [], characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" };
	const exact = await Effect.runPromise(searchMessages(mysql, 'reading-list "lists" notes', 42, false, config));
	expect(mysql`SELECT id FROM visible_messages WHERE ${exact}`.compile()[1]).toContain(
		'+"reading list" +"lists" +("notes" "note")',
	);
});

it("rejects invalid search syntax before any engine receives a query", async () => {
	for (const name of ["sqlite", "pg", "mysql"] as const)
		for (const query of [
			"",
			" ",
			'"unterminated',
			'""',
			"***",
			"a\0b",
			"x".repeat(513),
			Array(17).fill("word").join(" "),
		]) {
			const result = await Effect.runPromise(searchMessages(constructor(name), query, 1).pipe(Effect.result));
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(Schema.is(KernelError)(result.failure)).toBe(true);
				if (Schema.is(KernelError)(result.failure)) expect(result.failure.code).toBe("query_invalid");
			}
		}
});

it("drops wholly unindexed MySQL parts while preserving AND and phrase words", async () => {
	const sql = constructor("mysql");
	const config = { minimum: 4, maximum: 84, stopwords: [], characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" };
	for (const [query, expression] of [
		["the deploy alpha", '+("deploy" "deploys") +("alpha" "alphas")'],
		['"the deploy" alpha', '+"the deploy" +("alpha" "alphas")'],
		["ok deploy", '+("deploy" "deploys")'],
	]) {
		const fragment = await Effect.runPromise(searchMessages(sql, query ?? "", 42, false, config));
		const [text, values] = sql`SELECT id FROM visible_messages WHERE ${fragment}`.compile();
		expect(values).toContain(expression);
		expect(values.filter((value) => value === 42)).toHaveLength(2);
		expect(text).toContain("MATCH(previous_body)");
	}
	const allExcluded = await Effect.runPromise(searchMessages(sql, "the ok", 42, false, config));
	const [text] = sql`SELECT id FROM visible_messages WHERE ${allExcluded}`.compile();
	expect(text).toContain("1=1");
	expect(text).not.toContain("MATCH");
});
