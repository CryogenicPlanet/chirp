import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const execute = promisify(execFile);
for (const engine of ["sqlite", "pg", "mysql"])
	it.skipIf(engine !== "sqlite" && !process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR)(
		`${engine} links, signs in, races and unlinks GitHub and Google identities on its own SQL`,
		async () => {
			const { stdout } = await execute("bun", [
				`${import.meta.dirname}/fixtures/identity-links-native.ts`,
				engine,
				process.env.COMMS_INITIALIZE_NATIVE_CONFIG_DIR ?? "",
			]);
			expect(JSON.parse(stdout)).toEqual({ engine, passed: true });
		},
		30000,
	);
