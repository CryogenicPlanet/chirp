import { BunServices } from "@effect/platform-bun";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it, type TestContext } from "vitest";
import {
	encodeIngress,
	ingressConfiguration,
	ingressEnabled,
	seedIngressConfiguration,
} from "../src/ingress-configuration.ts";

const directory = async (test: TestContext) => {
	const root = await mkdtemp(join(tmpdir(), "chirp-ingress-config-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
};
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

it("refuses links, nonfiles, oversized and writable operator policy while absence means off", async (test) => {
	const root = await directory(test);
	const filename = join(root, "boot.config.json");
	const read = () => run(ingressConfiguration(root, true));
	expect(await read()).toEqual({ applicationManagedIngress: false, error: null });
	await symlink(join(root, "absent"), filename);
	expect(await read()).toEqual({ applicationManagedIngress: false, error: "boot_config_link" });
	await rm(filename);
	await mkdir(filename);
	expect(await read()).toEqual({ applicationManagedIngress: false, error: "boot_config_invalid_file" });
	await rm(filename, { recursive: true });
	await writeFile(filename, '{"applicationManagedIngress":true}', { mode: 0o600 });
	expect(await read()).toEqual({ applicationManagedIngress: true, error: null });
	await chmod(filename, 0o666);
	expect(await read()).toEqual({ applicationManagedIngress: false, error: "boot_config_permissions" });
	await chmod(filename, 0o600);
	await writeFile(filename, " ".repeat(16385));
	expect(await read()).toEqual({ applicationManagedIngress: false, error: "boot_config_invalid_file" });
});

it("reads off, all and a list of extensions, and fails closed on anything else", async (test) => {
	const root = await directory(test);
	const read = async (config: string) => {
		await writeFile(join(root, "boot.config.json"), config, { mode: 0o600 });
		return run(ingressConfiguration(root, true));
	};
	for (const [value, applicationManagedIngress] of [
		["false", false],
		["true", true],
		["[]", []],
		['["mcp","public-pages.ts"]', ["mcp", "public-pages.ts"]],
	] as const) {
		const ingress = await read(`{"applicationManagedIngress":${value}}`);
		expect(ingress).toEqual({ applicationManagedIngress, error: null });
		// The app receives the same JSON value the operator wrote.
		expect(encodeIngress(ingress.applicationManagedIngress)).toBe(value);
	}
	for (const value of ['"mcp"', '["*"]', '["mcp,public-pages.ts"]', '["../mcp"]', '[""]', "[true]"])
		expect(await read(`{"applicationManagedIngress":${value}}`), value).toEqual({
			applicationManagedIngress: false,
			error: "boot_config_invalid",
		});
	expect(ingressEnabled({ applicationManagedIngress: ["mcp"], error: null })).toBe(true);
	expect(ingressEnabled({ applicationManagedIngress: true, error: null })).toBe(true);
	expect(ingressEnabled({ applicationManagedIngress: [], error: null })).toBe(false);
	expect(ingressEnabled({ applicationManagedIngress: false, error: null })).toBe(false);
});

it("writes a new board's setting once, readable under isolated-mode checks, and never replaces what is there", async (test) => {
	const root = await directory(test);
	const filename = join(root, "boot.config.json");
	expect(await run(seedIngressConfiguration(root))).toBe(true);
	expect(await readFile(filename, "utf8")).toBe('{"applicationManagedIngress":["mcp"]}\n');
	expect((await stat(filename)).mode & 0o777).toBe(0o600);
	expect(await run(ingressConfiguration(root, true))).toEqual({ applicationManagedIngress: ["mcp"], error: null });
	expect(await readdir(root)).toEqual(["boot.config.json"]);
	// An operator's file, a broken one, a directory or a link all win over the new-board default.
	for (const existing of ['{"applicationManagedIngress":false}', "{broken"]) {
		await writeFile(filename, existing, { mode: 0o600 });
		expect(await run(seedIngressConfiguration(root))).toBe(false);
		expect(await readFile(filename, "utf8")).toBe(existing);
	}
	await rm(filename);
	await symlink(join(root, "elsewhere"), filename);
	expect(await run(seedIngressConfiguration(root))).toBe(false);
	await expect(stat(join(root, "elsewhere"))).rejects.toThrow();
	await rm(filename);
	await mkdir(filename);
	expect(await run(seedIngressConfiguration(root))).toBe(false);
	expect((await readdir(root)).sort()).toEqual(["boot.config.json"]);
});
