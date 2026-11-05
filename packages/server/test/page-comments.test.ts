import { assertionHeader } from "@comms/protocol/headers";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commentTopic, decorateHtmlPage, pageChrome } from "../src/page-comments.ts";
import { conversation } from "./fixtures/conversation.ts";

const client = "/page-assets/comments.js";
const palette = '<script type="module" src="/assets/board.js"></script>';
const search = "data-chirp-palette";

it("files comments under the nearest folder that is a topic path, else pages", () => {
	expect(commentTopic("home/renovation/plan.md")).toBe("home/renovation");
	expect(commentTopic("home/My Notes/plan.html")).toBe("home");
	expect(commentTopic("Home/plan.md")).toBe("pages");
	expect(commentTopic("plan.md")).toBe("pages");
	expect(commentTopic("@codex/notes.md")).toBe("@codex");
});

it("escapes every path segment in the bar and the client tag, and keeps the doctype first", () => {
	const name = `x&y/a"<b>'.html`;
	const page = decorateHtmlPage(
		"<!doctype html><html><head></head><body class=a><p>hi</p></body></html>",
		name,
		"rahul",
	);
	expect(page.startsWith('<!doctype html><html><head></head><body class=a><nav class="chirp-page-bar">')).toBe(true);
	expect(page).toContain('<a href="/p/x%26y">x&amp;y</a>');
	expect(page).toContain('<a href="/p/x%26y/a%22%3Cb%3E&#39;.html">a&quot;&lt;b&gt;&#39;.html</a>');
	expect(page).toContain('href="/p/x%26y/a%22%3Cb%3E&#39;.html?raw=1"');
	expect(page).toContain(`data-page="x&amp;y/a&quot;&lt;b&gt;&#39;.html" data-topic="pages" data-viewer="rahul"`);
	expect(page).not.toContain('a"<b>');
	expect(page.endsWith("<p>hi</p></body></html>")).toBe(true);
	expect(decorateHtmlPage("<!DOCTYPE html><title>t</title>", "t.html", "rahul").startsWith("<!DOCTYPE html><nav")).toBe(
		true,
	);
	expect(decorateHtmlPage("<head><title>t</title></head><p>x</p>", "t.html", "rahul")).toMatch(
		/^<head><title>t<\/title><\/head><nav/,
	);
	for (const meta of [
		'<meta name="chirp-comments" content="off">',
		"<meta content='OFF' name='chirp-comments' />",
		"<meta name=chirp-comments content=off>",
	])
		expect(pageChrome(meta, "t.html", "rahul"), meta).toEqual({ search: "", scripts: "" });
	const on = pageChrome('<meta name="chirp-comments" content="on">', "t.html", "rahul");
	expect(on.scripts).toContain(client);
	expect(on.scripts).toContain(palette);
	expect(on.search).toContain(search);
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
	const optOut =
		'<!doctype html><html><head><meta name="chirp-comments" content="off"></head><body>quiet</body></html>';
	await mkdir(join(fixture.root, "pages/home/renovation"), { recursive: true });
	await mkdir(join(fixture.root, "pages/public"), { recursive: true });
	await writeFile(join(fixture.root, "pages/home/renovation/plan.md"), "# Plan\n\nOak or maple?\n");
	await writeFile(join(fixture.root, "pages/home/renovation/plan.html"), html);
	await writeFile(join(fixture.root, "pages/home/renovation/quiet.html"), optOut);
	await writeFile(join(fixture.root, "pages/public/guide.md"), "# Guide\n");
	await writeFile(join(fixture.root, "pages/public/page.html"), html);
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
		for (const injected of [client, palette, search]) expect(body).not.toContain(injected);
	};

	const markdown = await text("/p/home/renovation/plan.md");
	expect(markdown).toContain(
		`<script defer src="${client}" data-page="home/renovation/plan.md" data-topic="home/renovation" data-viewer="`,
	);
	expect(markdown).toContain(palette);
	expect(markdown).toContain(search);
	expect(markdown).not.toContain("chirp-page-bar");
	const decorated = await text("/p/home/renovation/plan.html");
	expect(decorated).toContain('<body><nav class="chirp-page-bar">');
	expect(decorated).toContain(`data-page="home/renovation/plan.html"`);
	expect(decorated).toContain(palette);
	expect(decorated).toContain(search);
	expect(decorated).toContain("<h1>Plan</h1></body></html>");
	const head = await fetch(app.url + "/p/home/renovation/plan.html", { method: "HEAD", headers: { cookie } });
	expect(head.headers.get("content-security-policy")).toContain("script-src 'self';");
	expect(await text("/p/home/renovation/plan.html?raw=1")).toBe(html);
	expect(await text("/p/home/renovation/plan.md?raw=1")).toBe("# Plan\n\nOak or maple?\n");
	const quiet = await text("/p/home/renovation/quiet.html");
	expect(quiet).toContain("chirp-page-bar");
	bare(quiet);

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
