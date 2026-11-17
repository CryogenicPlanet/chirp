import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("greps published bodies newest first, follows edits and deletes, pages, and stops runaway patterns", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const grep = (query: string) => fetch(`${app.url}/api/grep?${query}`, { headers: { cookie } });
	const found = async (query: string) => {
		const response = await grep(query);
		expect(response.status, query).toBe(200);
		return response.json();
	};
	expect((await fetch(`${app.url}/api/grep?pattern=x`)).status).toBe(401);
	const records = [];
	for (const [topic, body] of [
		["home", "Saved the article to my Reading List\nfor later"],
		["home/books", "reading-list: three novels"],
		["work", "standup notes\nthe readng list typo"],
	]) {
		const response = await app.post("/api/messages", { topic, body }, cookie);
		expect(response.status).toBe(200);
		records.push(await response.json());
	}
	const seqs = records.map((record) => record.seq);

	const all = await found(`pattern=${encodeURIComponent("read(i)?ng.list")}`);
	expect(all.matches.map((hit: { seq: number }) => hit.seq)).toEqual(seqs.toReversed());
	expect(all).toMatchObject({ matched: 3, has_more: false });
	expect(all.matches[2].lines).toEqual([{ line: 1, text: "Saved the article to my Reading List", match: true }]);
	expect((await found("pattern=Reading")).matched).toBe(1);
	expect((await found("pattern=Reading&ignore_case=1")).matched).toBe(2);
	expect((await found("pattern=list&topic=home")).matched).toBe(2);
	expect((await found("pattern=list&topic=home/books")).matched).toBe(1);
	expect((await found("pattern=list&agent=nobody")).matched).toBe(0);
	expect((await found(`pattern=${encodeURIComponent("list:")}&fixed=1`)).matched).toBe(1);
	expect((await found("pattern=standup&context=1")).matches[0].lines).toEqual([
		{ line: 1, text: "standup notes", match: true },
		{ line: 2, text: "the readng list typo", match: false },
	]);

	const first = await found("pattern=list&limit=2");
	expect(first).toMatchObject({ matched: 3, has_more: true, next_before: seqs[1] });
	const rest = await found(`pattern=list&limit=2&before=${first.next_before}`);
	expect(rest).toMatchObject({ matched: 1, has_more: false, matches: [{ seq: seqs[0] }] });

	const mutate = (method: string, id: string, body?: unknown) =>
		fetch(`${app.url}/api/messages/${id}`, {
			method,
			headers: { cookie, origin: "https://comms.test", "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	expect((await mutate("PATCH", records[0].id, { body: "renamed nebula" })).status).toBe(200);
	expect((await mutate("DELETE", records[1].id)).status).toBe(200);
	expect((await found("pattern=list")).matches.map((hit: { seq: number }) => hit.seq)).toEqual([seqs[2]]);
	expect((await found("pattern=nebula")).matched).toBe(1);

	for (const query of [
		"",
		"pattern=",
		"pattern=x&context=6",
		"pattern=x&limit=0",
		"pattern=x&fixed=yes",
		"pattern=x&topic=../bad",
		"pattern=x&wat=1",
		"pattern=x&pattern=y",
		`pattern=${"a".repeat(501)}`,
	])
		expect((await grep(query)).status, query).toBe(400);
	const invalid = await grep("pattern=(unclosed");
	expect(invalid.status).toBe(400);
	expect((await invalid.json()).error.code).toBe("pattern_invalid");

	// JavaScriptCore gives up on a line after a few hundred milliseconds of backtracking and calls it no match.
	const backtracking = `${"a".repeat(30)}b`;
	expect((await app.post("/api/messages", { topic: "slow", body: backtracking }, cookie)).status).toBe(200);
	expect(await found(`pattern=${encodeURIComponent("^(a+)+$")}&topic=slow`)).toMatchObject({
		matched: 0,
		warning: expect.stringContaining("backtracked"),
	});

	// Polynomial patterns run on: only killing the scan process stops one.
	expect((await app.post("/api/messages", { topic: "slow", body: "a".repeat(60000) }, cookie)).status).toBe(200);
	const started = performance.now();
	const runaway = await grep(`pattern=${encodeURIComponent(".*.*.*x")}&topic=slow`);
	expect(runaway.status).toBe(400);
	expect((await runaway.json()).error.code).toBe("grep_timeout");
	expect(performance.now() - started).toBeLessThan(5000);
	// pgrep exits 1 when nothing matches.
	// The app runs from this fixture's data directory, so its path names only this board's scan processes.
	const workers = await promisify(execFile)("pgrep", ["-f", `${fixture.root}/.*grep-worker`]).then(
		({ stdout }) => stdout.trim(),
		() => "",
	);
	expect(workers).toBe("");

	// A scan pages through history in snapshots of 500 rows.
	for (let start = 0; start < 505; start += 50)
		await Promise.all(
			Array.from({ length: Math.min(50, 505 - start) }, (_, index) =>
				app.post("/api/messages", { topic: "bulk", body: `bulk ${start + index}` }, cookie),
			),
		);
	expect(await found("pattern=^bulk&topic=bulk&limit=100")).toMatchObject({
		matched: 505,
		scanned: 505,
		has_more: true,
	});
	expect((await found("pattern=nebula")).matched).toBe(1);
	expect(
		(await (await fetch(`${app.url}/api`, { headers: { cookie } })).json()).paths["/api/grep"].get.description,
	).toBeTruthy();
}, 30000);
