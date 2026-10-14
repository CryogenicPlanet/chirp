// Reads OIDC_ISSUER exactly as the launcher does, from the variables this process was given.
import { Console, Effect } from "effect";
import { oidcSetting } from "../../src/start.ts";

await Effect.runPromise(
	Effect.gen(function* () {
		yield* Console.log(JSON.stringify((yield* oidcSetting) ?? null));
	}),
);
