/* oxlint-disable effecttsgo/node-builtin-import */
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const environment = (issuer: string | undefined) => {
	const { OIDC_ISSUER: _inherited, ...rest } = process.env;
	return issuer === undefined ? rest : { ...rest, OIDC_ISSUER: issuer };
};

it("reads OIDC_ISSUER: auth.chirp.wiki when unset, off for none, and a near miss refuses startup", async (test) => {
	const read = async (issuer: string | undefined) =>
		JSON.parse(
			(
				await execute("bun", [join(import.meta.dirname, "fixtures/start-oidc.ts")], {
					env: environment(issuer),
				})
			).stdout,
		);
	expect(await read(undefined)).toEqual({ issuer: "https://auth.chirp.wiki" });
	// An empty value reads as unset.
	expect(await read("")).toEqual({ issuer: "https://auth.chirp.wiki" });
	expect(await read("none")).toBeNull();
	expect(await read("https://signin.example.com")).toEqual({ issuer: "https://signin.example.com" });
	// The real launcher stops before it touches the data directory, and says which variable to fix.
	const directory = await mkdtemp(join(tmpdir(), "comms-start-oidc-"));
	test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const port = await new Promise<number>((resolve) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
		});
	});
	const refused = await execute("bun", [join(import.meta.dirname, "../src/main.ts")], {
		env: { ...environment("https://auth.chirp.wiki/"), DATA_DIR: join(directory, "data"), PORT: String(port) },
		timeout: 20_000,
	}).then(
		() => null,
		(error: { readonly code?: number; readonly stderr?: string; readonly stdout?: string }) => error,
	);
	expect(refused?.code).toBe(1);
	expect(`${refused?.stdout}${refused?.stderr}`).toContain(
		'OIDC_ISSUER must be an https origin with no path or trailing slash, such as https://auth.chirp.wiki, or none; got "https://auth.chirp.wiki/"',
	);
	expect(await readdir(directory)).toEqual([]);
}, 30_000);
