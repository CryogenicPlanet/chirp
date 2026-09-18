import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "./fixtures/conversation.ts";

async function publishing(test: TestContext, enabled = true, installed = true) {
	const fixture = await conversation(test);
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: enabled }));
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../src"), seed, { recursive: true });
	if (installed) {
		const example = await readFile(join(import.meta.dirname, "../../../examples/extensions/public-pages.ts"), "utf8");
		await writeFile(
			join(seed, "ext/public-pages.ts"),
			example.replace("../../packages/server/src/kernel/extension-api.ts", "../kernel/extension-api.ts"),
		);
	}
	await mkdir(join(fixture.root, "pages/public/nested"), { recursive: true });
	await writeFile(join(fixture.root, "pages/private.md"), "private sibling");
	await writeFile(join(fixture.root, "pages/public/guide.md"), "# Public guide\n\n[asset](asset.bin)\n");
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	const cookie = await app.login();
	await app.ready(cookie);
	return { ...fixture, app, cookie };
}

it("requires both the operator opt-in and installation of the optional extension", async (test) => {
	for (const [enabled, installed] of [
		[false, true],
		[true, false],
	] as const) {
		const { app } = await publishing(test, enabled, installed);
		const response = await fetch(app.url + "/public/guide.md");
		expect(response.status).toBe(enabled ? 403 : 401);
		expect(await response.text()).not.toContain("Public guide");
		await app.stop();
	}
}, 40000);

it("publishes only its subtree, with mount-relative navigation, rendered/raw content and streaming binary HEAD", async (test) => {
	const { root, app, cookie } = await publishing(test);
	const binary = Buffer.alloc(150000, 139);
	binary[0] = 0;
	await writeFile(join(root, "pages/public/asset.bin"), binary);
	await writeFile(join(root, "pages/public/nested/index.md"), "# Nested\n");
	await writeFile(join(root, "pages/public/nested/index.html"), "markdown wins");
	const redirect = await fetch(app.url + "/public?raw=1", { redirect: "manual" });
	expect(redirect.status).toBe(302);
	expect(redirect.headers.get("location")).toBe("/public/?raw=1");
	const listing = await (await fetch(app.url + "/public/")).text();
	expect(listing).toContain('href="/public/guide.md"');
	expect(listing).toContain('href="/public/nested/"');
	expect(listing).not.toContain("private.md");
	expect(listing).not.toContain('href="/p/');
	expect(listing).not.toContain('href="/"');
	const rendered = await fetch(app.url + "/public/guide.md");
	expect(rendered.status).toBe(200);
	expect(rendered.headers.get("content-security-policy")).toContain("default-src 'none'");
	const body = await rendered.text();
	expect(body).toContain("<h1>Public guide</h1>");
	expect(body).toContain('href="/public/guide.md?raw=1"');
	expect(body).not.toContain('href="/p/');
	expect(body).not.toContain('href="/"');
	expect(await (await fetch(app.url + "/public/nested/")).text()).toContain("<h1>Nested</h1>");
	expect(await (await fetch(app.url + "/public/guide.md?raw=1")).text()).toBe("# Public guide\n\n[asset](asset.bin)\n");
	expect(Buffer.from(await (await fetch(app.url + "/public/asset.bin")).arrayBuffer())).toEqual(binary);
	for (const path of ["/public", "/public/", "/public/guide.md", "/public/asset.bin"]) {
		const head = await fetch(app.url + path, { method: "HEAD" });
		expect(head.status, path).toBe(200);
		expect(await head.text()).toBe("");
		if (path.endsWith(".bin")) expect(head.headers.get("content-length")).toBe(String(binary.length));
	}
	await rm(join(root, "pages/public/nested/index.md"));
	expect(await (await fetch(app.url + "/public/nested/")).text()).toBe("markdown wins");
	for (const path of ["/p/public/guide.md", "/p/private.md", "/api/messages"]) {
		expect((await fetch(app.url + path)).status, path).toBe(403);
	}
	expect((await fetch(app.url + "/p/private.md", { headers: { cookie } })).status).toBe(200);
	expect((await fetch(app.url + "/public/private.md")).status).toBe(404);
	for (const method of ["POST", "PUT", "DELETE"])
		expect((await fetch(app.url + "/public/guide.md", { method })).status, method).toBe(403);
	expect((await fetch(app.url + "/public/guide.md", { headers: { authorization: "Bearer invalid" } })).status).toBe(
		401,
	);
}, 30000);

it("refuses symlinks, traversal and publishing temporaries without exposing sibling content", async (test) => {
	const { root, app } = await publishing(test);
	await symlink(join(root, "pages/private.md"), join(root, "pages/public/linked.md"));
	await symlink(join(root, "pages"), join(root, "pages/public/alias"));
	await writeFile(join(root, "pages/public/.comms-pending.tmp"), "unpublished");
	for (const path of [
		"/public/linked.md",
		"/public/alias/private.md",
		"/public/a%2f..%2f..%2fprivate.md",
		"/public/.comms-pending.tmp",
		"/public/a%5cb",
		"/public/%ff",
	]) {
		const response = await fetch(app.url + path);
		expect(response.status, path).toBeGreaterThanOrEqual(400);
		expect(await response.text()).not.toContain("private sibling");
	}
	const listing = await (await fetch(app.url + "/public/")).text();
	expect(listing).not.toContain("linked.md");
	expect(listing).not.toContain("alias");
	expect(listing).not.toContain(".comms-");
}, 20000);
