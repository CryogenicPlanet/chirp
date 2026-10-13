import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { recoveryManifest } from "../src/route-discovery.ts";

it("serves immutable recovery metadata without opening authentication or app storage", async () => {
	const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/recovery-manifest.ts")]);
	const { status, headers, manifest } = JSON.parse(stdout);
	expect(status).toBe(200);
	expect(headers["cache-control"]).toBe("no-store");
	expect(headers["set-cookie"]).toBeUndefined();
	expect(manifest).toEqual(recoveryManifest(null));
	expect(manifest.revision).toBeNull();
	expect(manifest).toMatchObject({ api_url: "/api", init_url: "/init", recovery_url: "/_boot" });
	expect(manifest.endpoints["/_boot/db/restore"]).toHaveProperty("post.security", [{ commsBootSession: [] }]);
	expect(manifest.endpoints["/api/reload"]).toHaveProperty("post.security", [
		{ commsBootSession: [] },
		{ commsBootAccess: [] },
	]);
	expect(manifest.endpoints["/onboarding"]).toBeUndefined();
	expect(manifest.endpoints["/_boot/auth/state"]).toHaveProperty(
		"get.description",
		expect.stringContaining("verified human session"),
	);
	expect(manifest.endpoints["/_boot/seq"]).toBeUndefined();
	expect(manifest.endpoints["/_boot/events/append"]).toBeUndefined();
	expect(manifest.endpoints["/api/messages"]).toBeUndefined();
	expect(JSON.stringify(manifest)).not.toMatch(/Bearer invalid|forged|x-boot-secret/);
});

it("reports the commit the image was built from, and null for anything that is not a commit", async () => {
	const revisionOf = async (value: string) => {
		const { stdout } = await promisify(execFile)("bun", [join(import.meta.dirname, "fixtures/recovery-manifest.ts")], {
			env: { ...process.env, CHIRP_REVISION: value },
		});
		return JSON.parse(stdout).manifest.revision;
	};
	const commit = "0123456789abcdef0123456789abcdef01234567";
	expect(await revisionOf(commit)).toBe(commit);
	for (const value of ["", "main", "v0.2.0", "0123456789ABCDEF", "abc"]) expect(await revisionOf(value)).toBeNull();
});
