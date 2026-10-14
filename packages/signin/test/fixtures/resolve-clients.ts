import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ClientMetadata, loopbackLayerForTests } from "../../src/client-metadata.ts";

/**
 * Run under Bun by client-metadata.test.ts, because vitest's Node ignores Bun's fetch `tls` options and Host
 * override. Arguments: a redirect_uri, then client_ids. Prints one result per client_id as a JSON array.
 */
const [redirectUri = "", ...clientIds] = process.argv.slice(2);

const resolve = (clientId: string) =>
	Effect.gen(function* () {
		return (yield* (yield* ClientMetadata).resolve(clientId, redirectUri)).redirectOrigin;
	}).pipe(Effect.catchTag("ClientError", (error) => Effect.succeed(error.reason)));

Effect.forEach(clientIds, resolve).pipe(
	Effect.flatMap((results) => Console.log(JSON.stringify(results))),
	Effect.provide(loopbackLayerForTests.pipe(Layer.provide(FetchHttpClient.layer))),
	BunRuntime.runMain,
);
