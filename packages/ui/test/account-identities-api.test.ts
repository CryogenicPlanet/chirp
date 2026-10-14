import { assertionHeader } from "@comms/protocol/headers";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, expect, it, vi } from "vitest";
import { confirmLink, startLink, unlinkIdentity } from "../src/account-identities-api.ts";

afterEach(() => vi.unstubAllGlobals());

it("links a GitHub account through the issuer and a passkey, then unlinks it with a passkey", async () => {
	const pending = "p".repeat(43);
	const identity = "a".repeat(64);
	const requests: unknown[] = [];
	class Assertion {
		clientDataJSON = new Uint8Array([1]).buffer;
		authenticatorData = new Uint8Array([2]).buffer;
		signature = new Uint8Array([3]).buffer;
		userHandle = null;
	}
	class Credential {
		id = "credential";
		rawId = new Uint8Array([4]).buffer;
		response = new Assertion();
		getClientExtensionResults() {
			return {};
		}
	}
	const assign = vi.fn();
	vi.stubGlobal("window", { location: { origin: "https://board.test", assign } });
	vi.stubGlobal("navigator", { credentials: { get: async () => new Credential() } });
	vi.stubGlobal("PublicKeyCredential", Credential);
	vi.stubGlobal("AuthenticatorAssertionResponse", Assertion);
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push([
			init?.method,
			url.pathname,
			JSON.parse(String(init?.body)),
			new Headers(init?.headers).get(assertionHeader) !== null,
		]);
		if (url.pathname === "/_boot/auth/oidc/start")
			return Response.json({ authorization_url: "https://auth.chirp.wiki/authorize?state=private" });
		if (url.pathname === "/_boot/auth/challenge")
			return Response.json({
				id: "challenge",
				options: { challenge: "AQID", rpId: "board.test", timeout: 60000, userVerification: "required" },
			});
		return Response.json({ ok: true });
	});
	const run = (effect: Effect.Effect<void, unknown, never>) =>
		Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)));
	await run(startLink("github"));
	// The page leaves for the issuer itself; boot brings the human back with ?link= to confirm.
	expect(assign).toHaveBeenCalledWith("https://auth.chirp.wiki/authorize?state=private");
	await run(confirmLink(pending));
	await run(unlinkIdentity(identity));
	expect(requests).toEqual([
		["POST", "/_boot/auth/oidc/start", { intent: "link", provider: "github" }, false],
		["POST", "/_boot/auth/challenge", { action: "identity.link", params: { id: pending } }, false],
		["POST", "/_boot/auth/identities", { pending }, true],
		["POST", "/_boot/auth/challenge", { action: "identity.unlink", params: { id: identity } }, false],
		["DELETE", `/_boot/auth/identities/${identity}`, {}, true],
	]);
});
