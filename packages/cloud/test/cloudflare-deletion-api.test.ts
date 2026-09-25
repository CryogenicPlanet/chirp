import { Effect, Layer, Redacted, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, test } from "vitest";
import { CloudflareDeletionApi, cloudflareDeletionApiLayer } from "../src/cloudflare-deletion-api.ts";

test("deletes only the named record, accepts absence, and does not expose provider failures", async () => {
	for (const status of [200, 404, 401, 503]) {
		const requests: string[] = [];
		const layer = cloudflareDeletionApiLayer({
			token: Redacted.make("private-cloudflare-token"),
			zoneId: "a".repeat(32),
			baseUrl: "https://cloudflare.test",
		}).pipe(
			Layer.provide(
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) => {
						expect(request.method).toBe("DELETE");
						expect(request.headers.authorization).toBe("Bearer private-cloudflare-token");
						requests.push(request.url);
						return Effect.succeed(
							HttpClientResponse.fromWeb(request, new Response("private-provider-body", { status })),
						);
					}),
				),
			),
		);
		const result = await Effect.runPromise(
			CloudflareDeletionApi.use((api) => Effect.result(api.record("record/id"))).pipe(Effect.provide(layer)),
		);
		expect(Result.isSuccess(result)).toBe(status === 200 || status === 404);
		expect(JSON.stringify(result)).not.toContain("private-provider-body");
		expect(JSON.stringify(result)).not.toContain("private-cloudflare-token");
		expect(requests).toEqual([`https://cloudflare.test/client/v4/zones/${"a".repeat(32)}/dns_records/record%2Fid`]);
	}
});
