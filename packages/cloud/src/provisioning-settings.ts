import { Config, Data, Effect } from "effect";
import type { DeploymentSpec } from "./deployment.ts";

export interface ProvisioningSettings {
	readonly organization: string;
	readonly region: string;
	readonly boardsDomain: string;
	readonly volumeSizeGb: number;
	readonly maxFailures: number;
	readonly maxOperationAgeMs: number;
	readonly pollIntervalMs: number;
}

export class ProvisioningConfigurationError extends Data.TaggedError("ProvisioningConfigurationError")<{
	readonly message: string;
}> {}

const checked = (settings: ProvisioningSettings) =>
	Effect.gen(function* () {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(settings.organization))
			return yield* new ProvisioningConfigurationError({ message: "FLY_ORGANIZATION is invalid" });
		if (!/^[a-z0-9][a-z0-9-]*$/.test(settings.region))
			return yield* new ProvisioningConfigurationError({ message: "FLY_REGION is invalid" });
		if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(settings.boardsDomain))
			return yield* new ProvisioningConfigurationError({ message: "BOARDS_DOMAIN is invalid" });
		if (!Number.isSafeInteger(settings.volumeSizeGb) || settings.volumeSizeGb < 1)
			return yield* new ProvisioningConfigurationError({ message: "FLY_VOLUME_SIZE_GB must be a positive integer" });
		if (!Number.isSafeInteger(settings.maxFailures) || settings.maxFailures < 1)
			return yield* new ProvisioningConfigurationError({
				message: "PROVISIONING_MAX_FAILURES must be a positive integer",
			});
		if (!Number.isSafeInteger(settings.maxOperationAgeMs) || settings.maxOperationAgeMs < 1)
			return yield* new ProvisioningConfigurationError({
				message: "PROVISIONING_MAX_AGE_MS must be a positive integer",
			});
		if (!Number.isSafeInteger(settings.pollIntervalMs) || settings.pollIntervalMs < 1)
			return yield* new ProvisioningConfigurationError({
				message: "PROVISIONING_POLL_INTERVAL_MS must be a positive integer",
			});
		if (settings.pollIntervalMs > settings.maxOperationAgeMs)
			return yield* new ProvisioningConfigurationError({
				message: "PROVISIONING_POLL_INTERVAL_MS must not exceed PROVISIONING_MAX_AGE_MS",
			});
		return settings;
	});

export const provisioningSettings = Config.all({
	organization: Config.String("FLY_ORGANIZATION"),
	region: Config.String("FLY_REGION"),
	boardsDomain: Config.String("BOARDS_DOMAIN").pipe(Config.withDefault("boards.chirp.wiki")),
	// A board's first boot installs its app's dependencies and builds its UI into /data. One
	// gigabyte fills completely part way through that and the install fails, so the child never
	// serves. Measured on Fly: /data reached 100% at 907 MB with a 1 GB volume.
	volumeSizeGb: Config.Int("FLY_VOLUME_SIZE_GB").pipe(Config.withDefault(5)),
	maxFailures: Config.Int("PROVISIONING_MAX_FAILURES").pipe(Config.withDefault(10)),
	maxOperationAgeMs: Config.Int("PROVISIONING_MAX_AGE_MS").pipe(Config.withDefault(86_400_000)),
	pollIntervalMs: Config.Int("PROVISIONING_POLL_INTERVAL_MS").pipe(Config.withDefault(30_000)),
}).pipe(Effect.flatMap(checked));

// `imageRef` is the digest a board's release channel resolved to when it was first provisioned.
export const deploymentSpec = (slug: string, imageRef: string, settings: ProvisioningSettings): DeploymentSpec => ({
	hostname: `${slug}.${settings.boardsDomain}`,
	region: settings.region,
	image_ref: imageRef,
	app_name: `chirp-${slug}`,
	network_name: `chirp-${slug}`,
	// Fly rejects volume names over 30 characters, and a 32-character slug cannot fit in one.
	// Each board owns its Fly App, so the volume is already unique without repeating the slug.
	volume_name: "chirp_data",
	machine_name: `board-${slug}`,
	volume_size_gb: settings.volumeSizeGb,
});

export const legacyVolumeName = (slug: string) => `chirp_data_${slug}`;
