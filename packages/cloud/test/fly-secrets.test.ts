import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { FlySecrets, flySecretsLayer } from "../src/fly-secrets.ts";

const settings = { token: Redacted.make("private-fly-token"), baseUrl: "https://fly.test" };
const values = {
	DATABASE_URL: "postgres://private-password@db/main",
	REMOTE_GUARDIAN_URL: "postgres://secret@db/guardian",
};
const metadata = Object.keys(values).map((name) => ({ name, digest: `digest-${name}` }));
const ensure = FlySecrets.use((service) => service.ensure("board/name", Redacted.make(values)));
const run = <A, E>(effect: Effect.Effect<A, E, FlySecrets>, handle: Parameters<typeof HttpClient.make>[0]) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				flySecretsLayer(settings).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle)))),
			),
		),
	);

describe("FlySecrets", () => {
	test("upserts values then verifies only metadata at the returned version, including on retry", async () => {
		const seen: string[] = [];
		const result = await run(ensure.pipe(Effect.andThen(ensure)), (request) => {
			seen.push(`${request.method} ${request.url}`);
			expect(request.headers.authorization).toBe("Bearer private-fly-token");
			if (request.method === "POST") {
				if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
				expect(
					Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(request.body.body)),
				).toEqual({ values });
			}
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json(
						request.method === "POST"
							? { version: 17, secrets: metadata }
							: { secrets: metadata.map((item) => ({ ...item, value: "provider-must-not-return-this" })) },
					),
				),
			);
		});
		expect(result).toBe(17);
		expect(seen).toEqual(
			Array.from({ length: 2 }, () => [
				"POST https://fly.test/v1/apps/board%2Fname/secrets",
				"GET https://fly.test/v1/apps/board%2Fname/secrets?min_version=17&show_secrets=false",
			]).flat(),
		);
	});

	test.each(["missing", "mismatch", "duplicate", "empty_digest"])("refuses %s metadata", async (kind) => {
		const observed =
			kind === "missing"
				? []
				: kind === "duplicate"
					? [...metadata, metadata[0]]
					: metadata.map((item) => ({ ...item, digest: kind === "empty_digest" ? "" : "wrong" }));
		const result = await run(Effect.result(ensure), (request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json(request.method === "POST" ? { version: 17, secrets: metadata } : { secrets: observed }),
				),
			),
		);
		expect(result).toMatchObject({ failure: { reason: kind === "empty_digest" ? "decode" : "verification" } });
	});

	test.each([400, 403, 429, 500])("sanitizes provider failure %i", async (status) => {
		const result = await run(Effect.result(ensure), (request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(values), { status }))),
		);
		expect(result).toMatchObject({ failure: { reason: "status", status } });
		expect(JSON.stringify(result)).not.toContain("private-password");
		expect(JSON.stringify(result)).not.toContain("private-fly-token");
	});

	test("sanitizes invalid response without following it with a read", async () => {
		let calls = 0;
		const result = await run(Effect.result(ensure), (request) => {
			calls += 1;
			return Effect.succeed(
				HttpClientResponse.fromWeb(request, Response.json({ secrets: values, version: "private-password" })),
			);
		});
		expect(calls).toBe(1);
		expect(result).toMatchObject({ failure: { reason: "decode" } });
		expect(JSON.stringify(result)).not.toContain("private-password");
	});
});
