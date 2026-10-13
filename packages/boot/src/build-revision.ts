import { Config, Effect, Option } from "effect";

/**
 * The commit this image was built from, baked in as CHIRP_REVISION by the release build.
 * Null for a local or unstamped build, so a board never claims a version it cannot prove.
 */
export const buildRevision = Config.option(Config.String("CHIRP_REVISION")).pipe(
	Effect.map(Option.filter((value) => /^[0-9a-f]{7,40}$/.test(value))),
	Effect.map(Option.getOrNull),
	Effect.orElseSucceed(() => null),
);
