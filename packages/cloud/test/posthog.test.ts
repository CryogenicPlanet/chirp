import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { type PostHogSettings, postHogRequest, postHogSettings } from "../src/posthog.ts";

const load = (values: Readonly<Record<string, string>>) =>
	postHogSettings.pipe(
		Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
		Effect.runPromiseExit,
	);

const settings: PostHogSettings = {
	projectToken: "phc_test",
	ingestOrigin: "https://us.i.posthog.com",
	assetsOrigin: "https://us-assets.i.posthog.com",
	clientIpHeader: "fly-client-ip",
};

describe("PostHog settings", () => {
	test("stay disabled without a project token", async () => {
		expect(await load({})).toEqual(Exit.succeed(undefined));
	});

	test("derive the region's hosts from the ingestion host", async () => {
		const result = await load({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" });
		expect(result).toEqual(
			Exit.succeed({
				projectToken: "phc_test",
				ingestOrigin: "https://eu.i.posthog.com",
				assetsOrigin: "https://eu-assets.i.posthog.com",
				clientIpHeader: undefined,
			}),
		);
	});

	test.each(["http://us.i.posthog.com", "https://posthog.example.com", "https://us.i.posthog.com/ingest"])(
		"refuse %s as a host",
		async (host) => {
			expect(Exit.isFailure(await load({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: host }))).toBe(true);
		},
	);
});

describe("PostHog proxy request", () => {
	test("forwards events without Cloud cookies and with the authoritative client IP", async () => {
		const upstream = postHogRequest(
			new Request("https://cloud.chirp.wiki/ingest/e/?compression=gzip-js", {
				method: "POST",
				headers: {
					cookie: "__Host-chirp-cloud.session_token=secret",
					authorization: "Bearer secret",
					"content-type": "text/plain",
					"fly-client-ip": "203.0.113.7",
					"x-forwarded-for": "198.51.100.1",
				},
				body: "event",
			}),
			["e"],
			settings,
		);
		expect(upstream.url).toBe("https://us.i.posthog.com/e/?compression=gzip-js");
		expect([...upstream.headers]).toEqual([
			["content-type", "text/plain"],
			["x-forwarded-for", "203.0.113.7"],
		]);
		expect(await upstream.text()).toBe("event");
	});

	test("loads remote config from the assets host", () => {
		const upstream = postHogRequest(
			new Request("https://cloud.chirp.wiki/ingest/array/phc_test/config"),
			["array", "phc_test", "config"],
			settings,
		);
		expect(upstream.url).toBe("https://us-assets.i.posthog.com/array/phc_test/config");
	});

	test("cannot leave the PostHog host", () => {
		const upstream = postHogRequest(
			new Request("https://cloud.chirp.wiki/ingest/x"),
			["@evil.example", "..", "..", "x"],
			settings,
		);
		expect(new URL(upstream.url).origin).toBe("https://us.i.posthog.com");
	});
});
