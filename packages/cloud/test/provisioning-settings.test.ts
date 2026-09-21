import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { provisioningSettings } from "../src/provisioning-settings.ts";

const environment = {
	FLY_ORGANIZATION: "chirp",
	FLY_REGION: "sjc",
	CHIRP_IMAGE: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	BOARDS_DOMAIN: "boards.chirp.wiki",
	FLY_VOLUME_SIZE_GB: "1",
	PROVISIONING_MAX_FAILURES: "10",
	PROVISIONING_MAX_AGE_MS: "86400000",
	PROVISIONING_POLL_INTERVAL_MS: "30000",
};

const load = (values: Readonly<Record<string, string>>) =>
	provisioningSettings.pipe(
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
		Effect.runPromiseExit,
	);

describe("provisioning settings", () => {
	test("loads independent failure, lifetime, and polling budgets", async () => {
		const result = await load(environment);
		expect(Exit.isSuccess(result)).toBe(true);
		if (Exit.isSuccess(result))
			expect(result.value).toMatchObject({ maxFailures: 10, maxOperationAgeMs: 86_400_000, pollIntervalMs: 30_000 });
	});

	test("rejects nonpositive and internally inconsistent budgets", async () => {
		for (const override of [
			{ PROVISIONING_MAX_FAILURES: "0" },
			{ PROVISIONING_MAX_AGE_MS: "0" },
			{ PROVISIONING_POLL_INTERVAL_MS: "0" },
			{ PROVISIONING_MAX_AGE_MS: "100", PROVISIONING_POLL_INTERVAL_MS: "101" },
		])
			expect(Exit.isFailure(await load({ ...environment, ...override }))).toBe(true);
	});
});
