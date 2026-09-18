import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { identity } from "./conversation-request.ts";
import { Messages } from "./ext/core/messages.ts";
import { Pages } from "./ext/core/pages.ts";
import { routes as assetRoutes } from "./page-assets.ts";
import { servePage } from "./page-serving.ts";
import { pageFailure } from "./page-failure.ts";

const page = Effect.gen(function* () {
	yield* identity("read");
	return yield* servePage(
		yield* HttpServerRequest.HttpServerRequest,
		{ root: "", mount: "/p" },
		yield* Pages,
		(yield* Messages).read,
		yield* FileSystem.FileSystem,
	);
}).pipe(pageFailure);
export const routes = Layer.mergeAll(HttpRouter.add("GET", "/p/*", page), assetRoutes);
