import { expect, it } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

it("combines published message filters before pagination and keeps them across long-poll", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const first = await app.login(),
		second = await app.login();
	await app.ready(first);
	const read = (query: string) => fetch(`${app.url}/api/messages?${query}`, { headers: { cookie: first } });
	const query = async (extra: string) => {
		const response = await read(`since=0&${extra}`);
		expect(response.status).toBe(200);
		return response.json();
	};
	const create = async (topic: string, body: string, tags: string[], cookie = first) => {
		const response = await app.post("/api/messages", { topic, body, tags }, cookie);
		expect(response.status).toBe(200);
		return response.json();
	};
	await create("@pi", "café blue moon", ["answering"]);
	const one = await create("@pi", "café blue moon", ["answer", "odd'\"tag", ""]);
	await create("@pi-cloud", "café blue moon", ["answer"]);
	await create("@pi/child", "café blue distant moon", ["answer"]);
	const two = await create("@pi/child", "CAFÉ blue moon", ["answer"]);
	const filters = `topic=@pi&recursive=1&tag=answer&agent=rahul&q=${encodeURIComponent('cafe "blue moon"')}`;
	const page = await query(`${filters}&limit=1`);
	expect(page.items).toEqual([one]);
	const next = await (await read(`since=${page.cursor}&${filters}&limit=1`)).json();
	expect(next.items).toEqual([two]);
	expect(await (await read(`since=${next.cursor}&${filters}`)).json()).toEqual({
		items: [],
		cursor: expect.any(Number),
		timed_out: false,
		drained: false,
	});
	expect((await query("topic=@pi&tag=answer")).items).toEqual([one]);
	expect((await query("tag=Answer")).items).toEqual([]);
	expect((await query("agent=missing")).items).toEqual([]);
	expect((await query(`tag=${encodeURIComponent("odd'\"tag")}`)).items).toEqual([one]);
	expect((await query("tag=")).items).toEqual([one]);
	for (const invalid of [
		"tag=a&tag=b",
		"agent=rahul&agent=missing",
		"q=a&q=b",
		"agent=",
		"agent=../bad",
		"q=",
		"q=%22unfinished",
		`tag=${"x".repeat(101)}`,
		`q=${"x".repeat(513)}`,
	])
		expect((await read(`since=0&${invalid}`)).status, invalid).toBe(400);
	const waiting = read(`since=${two.seq}&${filters}&wait=5`);
	await create("@pi", "cafe blue moon own", ["answer"]);
	await create("@pi", "cafe blue moon wrong tag", ["question"], second);
	const reply = await create("@pi/child", "cafe blue moon reply", ["answer"], second);
	expect((await (await waiting).json()).items).toEqual([reply]);
	expect((await fetch(`${app.url}/api/messages?tag=answer&q=cafe`)).status).toBe(401);
	const docs = await (await fetch(`${app.url}/api`, { headers: { cookie: first } })).json();
	expect(docs.paths["/api/messages"].get.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(
		expect.arrayContaining(["tag", "agent", "q"]),
	);
}, 30000);

it("matches plural and hyphen variants and searches history when no cursor is given", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const reader = await app.login(),
		author = await app.login();
	await app.ready(reader);
	const create = async (body: string) => {
		const response = await app.post("/api/messages", { topic: "home", body }, author);
		expect(response.status).toBe(200);
		return ((await response.json()) as { readonly seq: number }).seq;
	};
	const search = async (query: string) => {
		const response = await fetch(`${app.url}/api/messages?${query}`, { headers: { cookie: reader } });
		expect(response.status, await response.clone().text()).toBe(200);
		return ((await response.json()) as { readonly items: ReadonlyArray<{ readonly seq: number }> }).items.map(
			(item) => item.seq,
		);
	};
	const q = (text: string) => `q=${encodeURIComponent(text)}`;
	const spaced = await create("Added the article to the reading list");
	const hyphened = await create("My reading-list keeps growing");
	const plural = await create("Two reading lists now");
	await create("Nothing to read here");

	// No cursor and no wait: a search reads all history, oldest first.
	expect(await search(q("reading list"))).toEqual([spaced, hyphened, plural]);
	expect(await search(q("reading lists"))).toEqual([spaced, hyphened, plural]);
	expect(await search(q("reading-list"))).toEqual([spaced, hyphened]);
	expect(await search(q('"reading lists"'))).toEqual([plural]);
	expect(await search(`${q("reading list")}&newest=1&limit=1`)).toEqual([plural]);
	expect(await search(`${q("reading list")}&since=${hyphened}`)).toEqual([plural]);
	// Following new matches still starts now.
	expect(await search(`${q("reading list")}&wait=1`)).toEqual([]);

	// A search inside a topic, on any page, leaves the reader's unread messages alone.
	const marks = () => fixture.sql("SELECT instance,topic,seq FROM reads ORDER BY instance,topic");
	const before = await marks();
	expect(await search(`topic=home&${q("growing")}`)).toEqual([hyphened]);
	expect(await search(`topic=home&${q("reading list")}&since=${spaced}`)).toEqual([hyphened, plural]);
	expect(await marks()).toEqual(before);
}, 30000);

it("pages backwards through a topic with newest and before", async (test) => {
	const fixture = await conversation(test),
		app = await fixture.launch();
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const seqs: number[] = [];
	for (const body of ["one", "two", "three", "four", "five"]) {
		const response = await app.post("/api/messages", { topic: "history", body }, cookie);
		expect(response.status).toBe(200);
		seqs.push((await response.json()).seq);
	}
	await app.post("/api/messages", { topic: "elsewhere", body: "noise" }, cookie);
	const page = async (query: string) => {
		const response = await fetch(`${app.url}/api/messages?topic=history&newest=1&mark=0&${query}`, {
			headers: { cookie },
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { items: { body: string }[] }).items.map((item) => item.body);
	};
	expect(await page("limit=2")).toEqual(["four", "five"]);
	expect(await page(`limit=2&before=${seqs[3]}`)).toEqual(["two", "three"]);
	expect(await page(`limit=2&before=${seqs[1]}`)).toEqual(["one"]);
	expect(await page(`limit=2&before=${seqs[0]}`)).toEqual([]);
	const forward = await fetch(`${app.url}/api/messages?topic=history&since=0&before=${seqs[2]}`, {
		headers: { cookie },
	});
	expect(forward.status).toBe(400);
});
