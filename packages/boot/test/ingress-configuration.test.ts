import { BunServices } from "@effect/platform-bun";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { encodeIngress, ingressConfiguration, ingressEnabled } from "../src/ingress-configuration.ts";

it("refuses links, nonfiles, oversized and writable operator policy while absence means MCP only", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "chirp-ingress-config-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const filename = join(root, "boot.config.json");
	const read = () => Effect.runPromise(ingressConfiguration(root, true).pipe(Effect.provide(BunServices.layer)));
	expect(await read()).toEqual({ applicationManagedIngress: ["mcp"], error: null });
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
	const root = await mkdtemp(join(tmpdir(), "chirp-ingress-config-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const read = async (config: string) => {
		await writeFile(join(root, "boot.config.json"), config, { mode: 0o600 });
		return Effect.runPromise(ingressConfiguration(root, true).pipe(Effect.provide(BunServices.layer)));
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
	expect(ingressEnabled(undefined)).toBe(false);
});
