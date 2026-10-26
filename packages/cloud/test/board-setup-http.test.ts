import { expect, test } from "vitest";
import { makeBoardOpenHttp, makeBoardSetupHttp } from "../src/board-setup-http.ts";
const id = "01956d31-c55b-7a01-9088-927182bece80";
const payload = {
	ok: true as const,
	code: "private-setup-code",
	expires_at: "2026-09-21T12:15:00.000Z",
	onboarding_url: "https://board.test/onboarding",
	setup_url: "https://board.test/setup#code=private-setup-code",
	identities: 1,
};
const request = (body = "{}", origin = "https://cloud.test", path = "setup-code") =>
	new Request(`https://cloud.test/api/boards/a/${path}`, {
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

test("open answers only a signed-in owner's same-origin empty POST, with a board URL or the setup-code fallback", async () => {
	const opened: Array<string> = [];
	const session = {
		getSession: async () => ({
			session: { user: { id: "owner", name: "Owner", email: "owner@test.dev" } },
			headers: new Headers({ "set-cookie": "renewed=1" }),
		}),
		getPublicOrigin: async () => "https://cloud.test",
	};
	const http = (open: Parameters<typeof makeBoardOpenHttp>[0]["open"]) => makeBoardOpenHttp({ ...session, open });
	const answers = {
		setup: { ok: true, url: "https://board.test/setup#code=private-setup-code" },
		login: { ok: true, url: "https://board.test/auth/login?provider=github&next=/" },
		issued: { ok: true, fallback: "setup_code", code: "private-setup-code", expires_at: "2026-09-21T12:15:00.000Z" },
		fallback: { ok: true, fallback: "setup_code" },
	} as const;
	for (const [name, answer] of Object.entries(answers)) {
		const response = await http(async (owner, board) => {
			opened.push(`${owner}:${board}:${name}`);
			return answer;
		})(request("{}", "https://cloud.test", "open"), id);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const { ok: _ok, ...body } = answer;
		expect(await response.json()).toEqual(body);
	}
	expect(opened).toEqual([`owner:${id}:setup`, `owner:${id}:login`, `owner:${id}:issued`, `owner:${id}:fallback`]);
	const never = http(async () => {
		throw new Error("unexpected open");
	});
	for (const [req, board, status] of [
		[request("{}", "https://evil.test", "open"), id, 403],
		[request("{}", "null", "open"), id, 403],
		[request('{"next":"https://evil.test"}', "https://cloud.test", "open"), id, 400],
		[request("[]", "https://cloud.test", "open"), id, 400],
		[request(), "../setup-code", 404],
	] as const)
		expect((await never(req, board)).status).toBe(status);
	const anonymous = makeBoardOpenHttp({
		...session,
		getSession: async () => ({ session: null, headers: new Headers() }),
		open: async () => {
			throw new Error("unexpected open");
		},
	});
	expect((await anonymous(request("{}", "https://cloud.test", "open"), id)).status).toBe(401);
	for (const code of ["not_found", "board_unavailable"] as const) {
		const response = await http(async () => ({ ok: false, code }))(request("{}", "https://cloud.test", "open"), id);
		expect(response.status).toBe(code === "not_found" ? 404 : 503);
		expect(await response.json()).toEqual({ error: { code } });
	}
	const failed = await http(async () => {
		throw new Error("secret exec stdout");
	})(request("{}", "https://cloud.test", "open"), id);
	expect(failed.status).toBe(503);
	expect(await failed.text()).not.toContain("secret");
});
