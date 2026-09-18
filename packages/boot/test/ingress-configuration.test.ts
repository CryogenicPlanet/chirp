import { BunServices } from "@effect/platform-bun";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ingressConfiguration } from "../src/ingress-configuration.ts";

it("refuses links, nonfiles, oversized and writable operator policy while absence defaults off", async (test) => {
	const root = await mkdtemp(join(tmpdir(), "chirp-ingress-config-"));
	test.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const filename = join(root, "boot.config.json");
	const read = () => Effect.runPromise(ingressConfiguration(root, true).pipe(Effect.provide(BunServices.layer)));
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
