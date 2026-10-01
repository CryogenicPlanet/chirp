import { Effect } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { afterEach, expect, it, vi } from "vitest";
import { accountRequest } from "../src/account-api.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

it("allows recovery calls to omit the browser request deadline", async () => {
	let finish: ((response: Response) => void) | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		),
	);
	let settled = false;
	const pending = Effect.runPromise(
		accountRequest(HttpClientRequest.post("https://board.test/_boot/revert"), null),
	).finally(() => {
		settled = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(settled).toBe(false);
	finish?.(Response.json({ generation: 2, status: "live" }));
	expect(await pending).toEqual({ generation: 2, status: "live" });
});
