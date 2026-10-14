import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import * as ClientMetadata from "./client-metadata.ts";
import * as Issuer from "./issuer.ts";
import { routes } from "./routes.ts";
import * as Settings from "./settings.ts";
import * as Upstream from "./upstream.ts";

// The request logger is off: query strings carry upstream codes and the board's state and nonce.
const server = Effect.gen(function* () {
	const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080));
	const hostname = yield* Config.String("HOST").pipe(Config.withDefault("127.0.0.1"));
	return HttpRouter.serve(routes, { disableLogger: true }).pipe(
		Layer.provide(
			Layer.mergeAll(Issuer.layer, ClientMetadata.layer, Upstream.layer()).pipe(
				Layer.provideMerge(Layer.mergeAll(Settings.layer, FetchHttpClient.layer)),
			),
		),
		Layer.provide(BunHttpServer.layer({ hostname, port, maxRequestBodySize: 16 * 1024 })),
	);
}).pipe(Layer.unwrap);

BunRuntime.runMain(Layer.launch(server));
