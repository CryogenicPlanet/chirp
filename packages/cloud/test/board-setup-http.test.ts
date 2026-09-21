import { expect, test } from "vitest";
import { makeBoardSetupHttp } from "../src/board-setup-http.ts";
const id = "01956d31-c55b-7a01-9088-927182bece80";
const payload = {
	ok: true as const,
	code: "private-setup-code",
	expires_at: "2026-09-21T12:15:00.000Z",
	onboarding_url: "https://board.test/onboarding",
};
const request = (body = "{}", origin = "https://cloud.test") =>
	new Request("https://cloud.test/api/boards/a/setup-code", {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body,
	});
test("owner session, exact origin, strict empty bounded JSON, renewal and secret-safe no-store errors", async () => {
	let calls = 0;
	const base = {
		getSession: async () => ({
			session: { user: { id: "owner", name: "Owner", email: "owner@test.dev" } },
			headers: new Headers({ "set-cookie": "renewed=1" }),
		}),
		getPublicOrigin: async () => "https://cloud.test",
		issue: async (owner: string, board: string) => {
			expect(owner).toBe("owner");
			expect(board).toBe(id);
			calls++;
			return payload;
		},
	};
	const http = makeBoardSetupHttp(base);
	for (const [req, board, status] of [
		[request("{}", "https://evil.test"), id, 403],
		[request('{"command":"evil"}'), id, 400],
		[request(" ".repeat(4097)), id, 400],
		[request(), "bad", 404],
	] as const) {
		const response = await http(req, board);
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toContain("renewed");
	}
	expect(calls).toBe(0);
	const success = await http(request(), id);
	expect(await success.json()).toEqual({
		code: payload.code,
		expires_at: payload.expires_at,
		onboarding_url: payload.onboarding_url,
	});
	const anonymous = makeBoardSetupHttp({
		...base,
		getSession: async () => ({ session: null, headers: new Headers() }),
	});
	expect((await anonymous(request(), id)).status).toBe(401);
	for (const code of ["not_found", "setup_closed", "setup_code_unavailable"] as const) {
		const response = await makeBoardSetupHttp({ ...base, issue: async () => ({ ok: false, code }) })(request(), id);
		expect(response.status).toBe(code === "not_found" ? 404 : code === "setup_closed" ? 409 : 503);
	}
	const failed = await makeBoardSetupHttp({
		...base,
		issue: async () => {
			throw new Error("secret stdout credential");
		},
	})(request(), id);
	expect(await failed.text()).not.toContain("secret");
});
