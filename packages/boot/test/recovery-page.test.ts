import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { recoveryPage } from "../src/recovery-page.ts";

it("keeps the revert request open while retaining a deadline on lock reads", async () => {
	const status = { textContent: "" };
	let click: (() => Promise<void>) | undefined;
	let finishRevert: ((response: Response) => void) | undefined;
	const requests: Array<{ readonly path: string; readonly init: RequestInit }> = [];
	const script = recoveryPage.match(/<script>([\s\S]*)<\/script>/)?.[1];
	if (!script) throw new Error("Recovery script is missing");
	runInNewContext(script, {
		document: {
			getElementById: (id: string) =>
				id === "status"
					? status
					: {
							disabled: false,
							textContent: "Revert last source change",
							addEventListener: (_name: string, handler: () => Promise<void>) => {
								click = handler;
							},
						},
		},
		crypto: { randomUUID: () => "revert-key" },
		AbortSignal,
		Error,
		fetch: (path: string, init: RequestInit) => {
			requests.push({ path, init });
			if (path === "/_boot/lock") return Promise.resolve(Response.json({ lock: { id: "human" } }));
			return new Promise<Response>((resolve) => {
				finishRevert = resolve;
			});
		},
	});
	if (!click) throw new Error("Missing recovery click handler");
	const pending = click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[0]).toMatchObject({ path: "/_boot/lock" });
	expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
	expect(requests[1]).toMatchObject({ path: "/_boot/revert", init: { method: "POST" } });
	expect(requests[1]?.init.signal).toBeUndefined();
	expect(requests[1]?.init.headers).toMatchObject({ "Idempotency-Key": "revert-key" });
	finishRevert?.(Response.json({ generation: 2, status: "live" }));
	await pending;
	expect(status.textContent).toBe("Source reverted. Open the board to check it.");
});
