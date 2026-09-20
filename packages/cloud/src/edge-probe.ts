import { Context, Data, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export class EdgeProbeError extends Data.TaggedError("EdgeProbeError")<{
	readonly path: "/health" | "/init";
	readonly reason: "network" | "redirect" | "status";
}> {}

const make = Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient;
	const observe = (hostname: string, path: "/health" | "/init") =>
		Effect.scoped(
			HttpClient.withScope(client)
				.execute(HttpClientRequest.get(`https://${hostname}${path}`))
				.pipe(
					Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
					Effect.mapError(() => new EdgeProbeError({ path, reason: "network" })),
					Effect.flatMap((response) =>
						response.arrayBuffer.pipe(
							Effect.mapError(() => new EdgeProbeError({ path, reason: "network" })),
							Effect.flatMap(() =>
								response.status >= 300 && response.status < 400
									? Effect.fail(new EdgeProbeError({ path, reason: "redirect" }))
									: response.status === 200
										? Effect.void
										: Effect.fail(new EdgeProbeError({ path, reason: "status" })),
							),
						),
					),
					Effect.timeout("15 seconds"),
					Effect.catchTag("TimeoutError", () => Effect.fail(new EdgeProbeError({ path, reason: "network" }))),
				),
		);
	return {
		health: (hostname: string) => observe(hostname, "/health"),
		childRoute: (hostname: string) => observe(hostname, "/init"),
	};
});

export class EdgeProbe extends Context.Service<EdgeProbe, Effect.Success<typeof make>>()("comms/cloud/EdgeProbe") {}
export const edgeProbeLayer = Layer.effect(EdgeProbe, make);
