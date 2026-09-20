import { Config, Data, Effect } from "effect";
import type { DeploymentSpec } from "./deployment.ts";

export interface ProvisioningSettings {
	readonly organization: string;
	readonly region: string;
	readonly imageRef: string;
	readonly boardsDomain: string;
	readonly volumeSizeGb: number;
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
		if (!/@sha256:[0-9a-f]{64}$/.test(settings.imageRef))
			return yield* new ProvisioningConfigurationError({ message: "CHIRP_IMAGE must be digest-pinned" });
		if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(settings.boardsDomain))
			return yield* new ProvisioningConfigurationError({ message: "BOARDS_DOMAIN is invalid" });
		if (!Number.isSafeInteger(settings.volumeSizeGb) || settings.volumeSizeGb < 1)
			return yield* new ProvisioningConfigurationError({ message: "FLY_VOLUME_SIZE_GB must be a positive integer" });
		return settings;
	});

export const provisioningSettings = Config.all({
	organization: Config.String("FLY_ORGANIZATION"),
	region: Config.String("FLY_REGION"),
	imageRef: Config.String("CHIRP_IMAGE"),
	boardsDomain: Config.String("BOARDS_DOMAIN").pipe(Config.withDefault("boards.chirp.wiki")),
	volumeSizeGb: Config.Int("FLY_VOLUME_SIZE_GB").pipe(Config.withDefault(1)),
}).pipe(Effect.flatMap(checked));

export const deploymentSpec = (slug: string, settings: ProvisioningSettings): DeploymentSpec => ({
	hostname: `${slug}.${settings.boardsDomain}`,
	region: settings.region,
	image_ref: settings.imageRef,
	app_name: `chirp-${slug}`,
	network_name: `chirp-${slug}`,
	volume_name: `chirp_data_${slug}`,
	machine_name: `board-${slug}`,
	volume_size_gb: settings.volumeSizeGb,
});
