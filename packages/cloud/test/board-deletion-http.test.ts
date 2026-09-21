import { describe, expect, test, vi } from "vitest";
import { makeBoardDeletionHttp } from "../src/board-deletion-http.ts";

const id = "01956d31-c55b-7a01-9088-927182bece80";
const session = { user: { id: "owner", name: "Owner", email: "owner@example.test" } };
const make = () => ({
	getSession: vi.fn(async (): Promise<{ session: typeof session | null; headers: Headers }> => ({
		session,
		headers: new Headers({ "set-cookie": "renewed=yes; HttpOnly" }),
	})),
	getPublicOrigin: vi.fn(async () => "https://cloud.test"),
	remove: vi.fn(
		async (): Promise<
			| { ok: true; deleted: true }
			| { ok: false; code: "not_found" | "confirmation_mismatch" | "operation_active" | "idempotency_conflict" }
		> => ({ ok: true, deleted: true }),
	),
});
const request = (overrides: Record<string, string> = {}, body: unknown = { confirmation_name: "Board" }) =>
	new Request(`https://cloud.test/api/boards/${id}`, {
		method: "DELETE",
		headers: {
			origin: "https://cloud.test",
			"content-type": "application/json",
			"idempotency-key": "delete-key",
			...overrides,
		},
		body: JSON.stringify(body),
	});
describe("board deletion HTTP", () => {
	test("requires session, exact public Origin, bounded JSON and idempotency key", async () => {
		const anonymous = make();
		anonymous.getSession.mockResolvedValue({ session: null, headers: new Headers() });
		expect((await makeBoardDeletionHttp(anonymous)(request(), id)).status).toBe(401);
		expect(anonymous.remove).not.toHaveBeenCalled();
		for (const [req, status] of [
			[request({ origin: "https://evil.test" }), 403],
			[request({ "idempotency-key": "" }), 400],
			[request({ "idempotency-key": "a".repeat(201) }), 400],
			[request({}, { confirmation_name: "a".repeat(5_000) }), 400],
			[request({}, {}), 400],
			[request({}, { confirmation_name: "Board", owner_id: "other" }), 400],
			[request({ "content-type": "text/plain" }), 400],
		] as const) {
			const deps = make();
			expect((await makeBoardDeletionHttp(deps)(req, id)).status).toBe(status);
			expect(deps.remove).not.toHaveBeenCalled();
		}
	});
	test("gives the same uncached 404 for malformed, absent and foreign boards", async () => {
		for (const boardId of ["not-a-uuid", id]) {
			const deps = make();
			deps.remove.mockResolvedValue({ ok: false, code: "not_found" });
			const response = await makeBoardDeletionHttp(deps)(request(), boardId);
			expect(response.status).toBe(404);
			expect(response.headers.get("set-cookie")).toBe("renewed=yes; HttpOnly");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toEqual({ error: { code: "not_found" } });
		}
	});
	test("passes only session ownership and preserves exact confirmation", async () => {
		const deps = make();
		const response = await makeBoardDeletionHttp(deps)(request({}, { confirmation_name: " Board " }), id);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBe("renewed=yes; HttpOnly");
		expect(await response.json()).toEqual({ deleted: true });
		expect(deps.remove).toHaveBeenCalledWith("owner", id, {
			confirmation_name: " Board ",
			idempotency_key: "delete-key",
		});
	});
});
