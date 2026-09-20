import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { EdgeProbe, edgeProbeLayer } from "../src/edge-probe.ts";

const run = <A, E>(effect: Effect.Effect<A, E, EdgeProbe>, handle: Parameters<typeof HttpClient.make>[0]) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(edgeProbeLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle))))),
		),
	);

describe("EdgeProbe", () => {
	test("observes boot health and a public child route through the exact hostname", async () => {
		const urls: string[] = [];
		await run(
			Effect.gen(function* () {
				const probe = yield* EdgeProbe;
				yield* probe.health("board.example.com");
				yield* probe.childRoute("board.example.com");
			}),
			(request) => {
				urls.push(request.url);
				return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
			},
		);
		expect(urls).toEqual(["https://board.example.com/health", "https://board.example.com/init"]);
	});

	test("refuses redirects and non-success responses", async () => {
		for (const status of [302, 503]) {
			const error = await run(Effect.flip(EdgeProbe.use((probe) => probe.childRoute("board.example.com"))), (request) =>
				Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
			);
			expect(error.reason).toBe(status === 302 ? "redirect" : "status");
		}
	});
});
