import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { deploymentSpec, type ProvisioningSettings, provisioningSettings } from "../src/provisioning-settings.ts";

const environment = {
	FLY_ORGANIZATION: "chirp",
	FLY_REGION: "sjc",
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

const imageRef = `registry.example/chirp@sha256:${"a".repeat(64)}`;

const settings: ProvisioningSettings = {
	organization: "chirp-org",
	region: "sjc",
	boardsDomain: "boards.chirp.wiki",
	volumeSizeGb: 1,
	maxFailures: 10,
	maxOperationAgeMs: 86_400_000,
	pollIntervalMs: 30_000,
};

// Slugs are 16 random bytes rendered as hex, so every derived name is built on 32 characters.
const slug = "0123456789abcdef0123456789abcdef";

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

describe("deploymentSpec", () => {
	test("derives names Fly accepts for a full-length slug", () => {
		const spec = deploymentSpec(slug, imageRef, settings);
		// Fly: "name only allows lowercase alphanumeric characters and underscores with at most 30 characters".
		expect(spec.volume_name).toMatch(/^[a-z0-9_]{1,30}$/);
		for (const name of [spec.app_name, spec.network_name, spec.machine_name]) {
			expect(name).toMatch(/^[a-z0-9-]+$/);
			expect(name.length).toBeLessThanOrEqual(63);
		}
		for (const label of spec.hostname.split(".")) expect(label.length).toBeLessThanOrEqual(63);
	});

	test("scopes the volume to the board's own app rather than the slug", () => {
		const first = deploymentSpec(slug, imageRef, settings);
		const second = deploymentSpec("fedcba9876543210fedcba9876543210", imageRef, settings);
		expect(first.app_name).not.toBe(second.app_name);
		expect(first.volume_name).toBe(second.volume_name);
	});
});
