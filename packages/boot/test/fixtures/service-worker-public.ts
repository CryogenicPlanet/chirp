import { BunServices } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { publicRoute } from "../../src/proxy.ts";

const response = await Effect.runPromise(
	publicRoute.pipe(
		Effect.provideService(
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(new Request("http://localhost/worker.js", { headers: { "service-worker": "script" } })),
		),
		Effect.provide(BunServices.layer),
	),
);
if (!response) throw new Error("expected a refusal");
const web = HttpServerResponse.toWeb(response);
Effect.runSync(
	Console.log(
		JSON.stringify({
			status: web.status,
			headers: Object.fromEntries(web.headers),
			body: await web.json(),
		}),
	),
);
