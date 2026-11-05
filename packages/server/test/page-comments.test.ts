import { assertionHeader } from "@comms/protocol/headers";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commentTopic } from "../src/page-comments.ts";
import { conversation } from "./fixtures/conversation.ts";

const client = "/page-assets/comments.js";
const palette = '<script type="module" src="/assets/board.js"></script>';
const search = "data-chirp-palette";
const bar = '<nav class="chirp-page-bar">';

it("files comments under the nearest folder that is a topic path, else pages", () => {
	expect(commentTopic("home/renovation/plan.md")).toBe("home/renovation");
	expect(commentTopic("home/My Notes/plan.html")).toBe("home");
	expect(commentTopic("Home/plan.md")).toBe("pages");
	expect(commentTopic("plan.md")).toBe("pages");
	expect(commentTopic("@codex/notes.md")).toBe("@codex");
});

it("adds the bar, comment client and palette only to /p pages a signed-in human reads", async (test) => {
	const fixture = await conversation(test);
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	const example = await readFile(join(import.meta.dirname, "../../../examples/extensions/public-pages.ts"), "utf8");
	await writeFile(
		join(seed, "ext/public-pages.ts"),
		example.replace("../../packages/server/src/kernel/extension-api.ts", "../kernel/extension-api.ts"),
	);
	const html = "<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
	const decoys =
		"<!doctype html><html><head><title>Styling the <body> tag</title><!-- <body> --><style>/* <body> */</style></head>";
	const pages: Record<string, string> = {
		"home/renovation/plan.md": "# Plan\n\nOak or maple?\n",
		"home/renovation/plan.html": html,
		"home/renovation/decoys.html": `${decoys}<body class=a><p>hi</p></body></html>`,
		"home/renovation/unclosed.html": "<html><body><p>open",
		"home/renovation/bodiless.html": "<!DOCTYPE html><title>t</title><p>x</p>",
		"home/renovation/head-only.html": "<head><title>t</title></head><p>x</p>",
		"home/renovation/quiet.html":
			"<html><head><meta content='OFF' name='chirp-comments' /></head><body>q</body></html>",
		"home/renovation/bare.html": "<meta name=chirp-comments content=off><p>bare</p>",
		"home/renovation/quoted.md": '# Docs\n\nOpt out with `<meta name="chirp-comments" content="off">`.\n',
		"home/renovation/quiet.md": "---\nchirp-comments: off\n---\n# Quiet\n",
		"x&y/a\"<b>'.html": "<body><p>hi</p></body>",
		"public/guide.md": "# Guide\n",
		"public/page.html": html,
	};
	for (const [name, content] of Object.entries(pages)) {
		await mkdir(join(fixture.root, "pages", name, ".."), { recursive: true });
		await writeFile(join(fixture.root, "pages", name), content);
	}
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	const get = (path: string, headers: Record<string, string> = { cookie }) => fetch(app.url + path, { headers });
	const text = async (path: string, headers?: Record<string, string>) => {
		const response = await get(path, headers);
		expect(response.status, path).toBe(200);
		return response.text();
	};
	const bare = (body: string) => {
		for (const injected of [bar, client, palette, search]) expect(body).not.toContain(injected);
	};

	const markdown = await text("/p/home/renovation/plan.md");
	expect(markdown).toContain(
		`<script defer src="${client}" data-page="home/renovation/plan.md" data-topic="home/renovation" data-viewer="`,
	);
	expect(markdown).toContain(palette);
	expect(markdown).toContain(search);
	expect(markdown).not.toContain(bar);
	const decorated = await text("/p/home/renovation/plan.html");
	expect(decorated).toContain(`<body>${bar}`);
	expect(decorated).toContain(`data-page="home/renovation/plan.html"`);
	expect(decorated).toMatch(/<h1>Plan<\/h1><style>.*<\/script><\/body><\/html>$/);
	expect(decorated).toContain(palette);
	expect(decorated).toContain(search);
	const head = await fetch(app.url + "/p/home/renovation/plan.html", { method: "HEAD", headers: { cookie } });
	expect(head.headers.get("content-security-policy")).toContain("script-src 'self';");
	expect(await text("/p/home/renovation/plan.html?raw=1")).toBe(html);
	expect(await text("/p/home/renovation/plan.md?raw=1")).toBe(pages["home/renovation/plan.md"]);

	// Only the real body element counts, wherever else the text "<body>" appears.
	expect(await text("/p/home/renovation/decoys.html")).toMatch(
		new RegExp(`^${decoys.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}<body class=a>${bar}`),
	);
	expect(await text("/p/home/renovation/unclosed.html")).toMatch(/<p>open<style>.*<\/script>$/);
	expect(await text("/p/home/renovation/bodiless.html")).toMatch(/^<!DOCTYPE html><nav/);
	expect(await text("/p/home/renovation/head-only.html")).toMatch(/^<head><title>t<\/title><\/head><nav/);

	// Opting out keeps an HTML page's exact bytes; Markdown opts out only in frontmatter, not by quoting the tag.
	expect(await text("/p/home/renovation/quiet.html")).toBe(pages["home/renovation/quiet.html"]);
	expect(await text("/p/home/renovation/bare.html")).toBe(pages["home/renovation/bare.html"]);
	expect(await text("/p/home/renovation/quoted.md")).toContain(client);
	bare(await text("/p/home/renovation/quiet.md"));

	// Every path segment is escaped in the crumbs, the raw link and the client's data attributes.
	const escaped = await text("/p/" + ["x&y", "a\"<b>'.html"].map(encodeURIComponent).join("/"));
	expect(escaped).toContain('<a href="/p/x%26y">x&amp;y</a>');
	expect(escaped).toContain('<a href="/p/x%26y/a%22%3Cb%3E&#39;.html">a&quot;&lt;b&gt;&#39;.html</a>');
	expect(escaped).toContain('href="/p/x%26y/a%22%3Cb%3E&#39;.html?raw=1"');
	expect(escaped).toContain(`data-page="x&amp;y/a&quot;&lt;b&gt;&#39;.html" data-topic="pages" data-viewer="`);
	expect(escaped).not.toContain('a"<b>');

	const script = await get(client);
	expect(script.status).toBe(200);
	expect(script.headers.get("content-type")).toContain("text/javascript");
	expect(await script.text()).toContain("page-comment");
	expect((await get(client, {})).status).toBe(401);

	// Anonymous public reads, and signed-in reads of the same public mount, are never annotated.
	for (const headers of [{}, { cookie }]) {
		expect(await text("/public/page.html", headers)).toBe(html);
		bare(await text("/public/guide.md", headers));
	}

	// An agent reading with a token gets the page unchanged.
	const enrollment = await (await app.post("/auth/enroll", { name: "reader", kind: "agent", host: "test" })).json();
	const params = { id: enrollment.id, decision: "approve" as const, scopes: ["read"], long_lived: false };
	const proof = await app.assertion(params);
	const approved = await fetch(`${app.url}/_boot/enroll/${enrollment.id}/approve`, {
		method: "POST",
		headers: { origin: "https://comms.test", "content-type": "application/json", [assertionHeader]: proof },
		body: JSON.stringify({ decision: params.decision, scopes: params.scopes, long_lived: params.long_lived }),
	});
	expect(approved.status).toBe(200);
	const token = await (
		await app.post(`/auth/enroll/${enrollment.id}`, { device_secret: enrollment.device_secret })
	).json();
	const bearer = { authorization: `Bearer ${token.access}` };
	expect(await text("/p/home/renovation/plan.html", bearer)).toBe(html);
	bare(await text("/p/home/renovation/plan.md", bearer));
}, 30000);
