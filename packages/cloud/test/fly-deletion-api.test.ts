import { Effect, Layer, Redacted, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, test } from "vitest";
import { FlyDeletionApi, flyDeletionApiLayer } from "../src/fly-deletion-api.ts";

test("uses verified DELETE contracts, accepts 404 and does not retry or leak failures", async () => {
	for (const status of [200, 202, 404, 401, 503]) {
		const requests: string[] = [];
		const layer = flyDeletionApiLayer({ token: Redacted.make("secret"), baseUrl: "https://fly.test" }).pipe(
			Layer.provide(
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) => {
						expect(request.method).toBe("DELETE");
						requests.push(request.url);
						return Effect.succeed(
							HttpClientResponse.fromWeb(request, new Response("provider-secret-body", { status })),
						);
					}),
				),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const api = yield* FlyDeletionApi;
				for (const operation of [api.machine("app", "machine"), api.volume("app", "volume"), api.app("app")]) {
					const result = yield* Effect.result(operation);
					expect(Result.isSuccess(result)).toBe(status < 300 || status === 404);
					expect(JSON.stringify(result)).not.toContain("provider-secret-body");
				}
			}).pipe(Effect.provide(layer)),
		);
		expect(requests).toEqual([
			"https://fly.test/v1/apps/app/machines/machine?force=true",
			"https://fly.test/v1/apps/app/volumes/volume",
			"https://fly.test/v1/apps/app",
		]);
	}
});
