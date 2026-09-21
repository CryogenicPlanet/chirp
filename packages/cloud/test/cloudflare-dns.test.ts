import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { CloudflareDns, cloudflareDnsLayer, cloudflareSettings } from "../src/cloudflare-dns.ts";

const zoneId = "a".repeat(32);
const record = {
	id: "record-id",
	name: "board.boards.chirp.wiki",
	type: "A",
	content: "66.241.124.100",
	proxied: false,
};
const run = <A, E>(effect: Effect.Effect<A, E, CloudflareDns>, handle: Parameters<typeof HttpClient.make>[0]) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				cloudflareDnsLayer({
					token: Redacted.make("private-cloudflare-token"),
					zoneId,
					baseUrl: "https://cloudflare.test",
				}).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle)))),
			),
		),
	);

describe("Cloudflare DNS API contract", () => {
	test("uses exact-name all-type reads and DNS-only writes in the configured zone", async () => {
		const seen: Array<{ method: string; url: string; body?: Schema.Json }> = [];
		await run(
			Effect.gen(function* () {
				const dns = yield* CloudflareDns;
				expect(yield* dns.getZone).toEqual({ name: "chirp.wiki", status: "active", type: "full" });
				expect(yield* dns.listRecords(record.name)).toEqual([record]);
				yield* dns.createRecord(record.name, "A", record.content);
				yield* dns.createRecord(`_fly-ownership.${record.name}`, "TXT", "app-123");
			}),
			(request) => {
				expect(request.headers.authorization).toBe("Bearer private-cloudflare-token");
				expect(JSON.stringify(request)).not.toContain("private-cloudflare-token");
				const body =
					request.body._tag === "Uint8Array"
						? Schema.decodeSync(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(request.body.body))
						: undefined;
				seen.push({ method: request.method, url: request.url, ...(body === undefined ? {} : { body }) });
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json(
							request.method === "POST"
								? { success: true, result: record }
								: request.url.includes("dns_records")
									? { success: true, result: [record], result_info: { total_count: 1 } }
									: { success: true, result: { name: "chirp.wiki", status: "active", type: "full" } },
						),
					),
				);
			},
		);
		expect(seen).toEqual([
			{ method: "GET", url: `https://cloudflare.test/client/v4/zones/${zoneId}` },
			{
				method: "GET",
				url: `https://cloudflare.test/client/v4/zones/${zoneId}/dns_records?name.exact=board.boards.chirp.wiki&per_page=100`,
			},
			{
				method: "POST",
				url: `https://cloudflare.test/client/v4/zones/${zoneId}/dns_records`,
				body: { name: record.name, type: "A", content: record.content, proxied: false, ttl: 60 },
			},
			{
				method: "POST",
				url: `https://cloudflare.test/client/v4/zones/${zoneId}/dns_records`,
				body: { name: `_fly-ownership.${record.name}`, type: "TXT", content: "app-123", proxied: false, ttl: 60 },
			},
		]);
	});

	test.each([403, 409, 429, 503])(
		"surfaces HTTP %s without retrying or exposing tokens or response bodies",
		async (status) => {
			let calls = 0;
			const result = await run(
				Effect.result(CloudflareDns.use((dns) => dns.createRecord(record.name, "A", record.content))),
				(request) => {
					calls += 1;
					return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("secret-provider-body", { status })));
				},
			);
			expect(result).toMatchObject({ failure: { operation: "create_record", reason: "status", status } });
			expect(JSON.stringify(result)).not.toContain("secret-provider-body");
			expect(JSON.stringify(result)).not.toContain("private-cloudflare-token");
			expect(calls).toBe(1);
		},
	);

	test("distinguishes interrupted response bodies from unsupported decoded shapes", async () => {
		const interrupted = await run(Effect.result(CloudflareDns.use((dns) => dns.getZone)), (request) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("connection reset"));
				},
			});
			return Effect.succeed(
				HttpClientResponse.fromWeb(request, new Response(stream, { headers: { "content-type": "application/json" } })),
			);
		});
		expect(interrupted).toMatchObject({ failure: { reason: "transport", status: 200 } });

		const unsupported = await run(Effect.result(CloudflareDns.use((dns) => dns.getZone)), (request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true, result: { name: 42 } }))),
		);
		expect(unsupported).toMatchObject({ failure: { reason: "decode", status: 200 } });
	});

	test.each([
		{ success: false, errors: [{ message: "secret-error" }], result: [] },
		{ success: true, result: [] },
		{ success: true, result: [record], result_info: { total_count: 101 } },
	])("refuses unsuccessful, malformed, or incomplete listings", async (value) => {
		const result = await run(Effect.result(CloudflareDns.use((dns) => dns.listRecords(record.name))), (request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value))),
		);
		expect(result).toMatchObject({ failure: { reason: "decode" } });
		expect(JSON.stringify(result)).not.toContain("secret-error");
	});

	test("loads a redacted token and rejects an invalid zone ID", async () => {
		const load = (zone: string) =>
			Effect.runPromise(
				cloudflareSettings.pipe(
					Effect.result,
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromEnv({
							env: {
								CLOUDFLARE_API_TOKEN: "secret-token",
								CLOUDFLARE_ZONE_ID: zone,
							},
						}),
					),
				),
			);
		expect(JSON.stringify(await load(zoneId))).not.toContain("secret-token");
		expect(await load("../other-zone")).toMatchObject({ failure: { operation: "configure_zone" } });
	});
});
