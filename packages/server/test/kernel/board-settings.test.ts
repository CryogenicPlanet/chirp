import { allExtensionsIngressProtocolVersion, ingressProtocolVersion } from "@comms/protocol/headers";
import { ConfigProvider, Effect } from "effect";
import { expect, it } from "vitest";
import { boardOwner, boardSettings, encodeIngressSetting } from "../../src/kernel/board-settings.ts";

const read = (env: Readonly<Record<string, string>>) =>
	Effect.runPromise(
		boardSettings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))),
	);

it("reads the ingress setting boot sends and fails closed on anything it cannot read", async () => {
	for (const [value, ingress] of [
		["true", true],
		["false", false],
		["[]", []],
		['["mcp","public-pages.ts"]', ["mcp", "public-pages.ts"]],
		["mcp", false],
		['{"applicationManagedIngress":true}', false],
		['["mcp",1]', false],
	] as const) {
		const settings = await read({ APPLICATION_MANAGED_INGRESS: value, BOARD_ORIGIN: "https://comms.test" });
		expect(settings, value).toEqual({
			board: { origin: "https://comms.test", ingress },
			ingressProtocol: ingressProtocolVersion,
		});
	}
	// The dispatcher echoes what it enforces in the encoding boot compares against.
	expect(encodeIngressSetting(["mcp", "public-pages.ts"])).toBe('["mcp","public-pages.ts"]');
	expect(encodeIngressSetting(false)).toBe("false");
});

it("offers a boot that sends no setting only the all-extensions protocol it already understands", async () => {
	expect(await read({})).toEqual({
		board: { origin: undefined, ingress: true },
		ingressProtocol: allExtensionsIngressProtocolVersion,
	});
});

it("reserves the human boot names, nobody before setup names one, and rahul under a boot from before naming", async () => {
	const owner = (env: Readonly<Record<string, string>>) =>
		Effect.runPromise(
			boardOwner.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))),
		);
	expect(await owner({ BOARD_OWNER: '"alice"' })).toBe("alice");
	expect(await owner({ BOARD_OWNER: "null" })).toBeNull();
	expect(await owner({ BOARD_OWNER: "alice" })).toBeNull();
	expect(await owner({})).toBe("rahul");
});
