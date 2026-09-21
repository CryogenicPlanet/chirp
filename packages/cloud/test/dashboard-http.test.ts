import { Option } from "effect";
import { describe, expect, test, vi } from "vitest";
import type { DashboardBoard } from "../src/dashboard-contract.ts";
import { makeDashboardHttp } from "../src/dashboard-http.ts";

const board: DashboardBoard = {
	id: "board-1",
	name: "Private board",
	hostname: null,
	storage_engine: "sqlite",
	region: null,
	volume_size_gb: null,
	phase: "queued",
	checkpoint: "requested",
	created_at: "2026-09-20T00:00:00.000Z",
	last_backup: null,
	error: null,
};

const session = { user: { id: "user-1", name: "Owner", email: "owner@example.com" } };
const renewedHeaders = new Headers({ "set-cookie": "renewed=session; Path=/; HttpOnly" });
const dependencies = () => ({
	getSession: vi.fn(async (): Promise<{ readonly session: typeof session | null; readonly headers: Headers }> => ({
		session,
		headers: renewedHeaders,
	})),
	getPublicOrigin: vi.fn(async () => "https://cloud.chirp.wiki"),
	list: vi.fn(async () => ({ boards: [board], truncated: false })),
	get: vi.fn(async () => Option.some(board)),
	create: vi.fn(
		async (): Promise<
			| { readonly ok: true; readonly board: DashboardBoard }
			| { readonly ok: false; readonly code: "idempotency_conflict" | "invalid_request" | "board_quota_exceeded" }
		> => ({ ok: true, board }),
	),
});

const request = (path = "/api/boards", init?: RequestInit) => new Request(`https://cloud.chirp.wiki${path}`, init);

describe("dashboard HTTP", () => {
	test("rejects unauthenticated reads before accessing dashboard data", async () => {
		const deps = dependencies();
		deps.getSession.mockResolvedValueOnce({ session: null, headers: renewedHeaders });
		const response = await makeDashboardHttp(deps).list(request());
		expect(response.status).toBe(401);
		expect(response.headers.getSetCookie()).toEqual(["renewed=session; Path=/; HttpOnly"]);
		expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
		expect(deps.list).not.toHaveBeenCalled();
	});

	test("lists only through the authenticated owner identity", async () => {
		const deps = dependencies();
		const response = await makeDashboardHttp(deps).list(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.getSetCookie()).toEqual(["renewed=session; Path=/; HttpOnly"]);
		expect(deps.list).toHaveBeenCalledWith("user-1");
		expect(await response.json()).toEqual({ boards: [board], truncated: false });
	});

	test("returns the same 404 for missing and foreign board identifiers", async () => {
		for (const id of ["01956d31-c55b-7a01-9088-927182bece80", "01956d31-c55b-7a01-9088-927182bece81"]) {
			const deps = dependencies();
			deps.get.mockResolvedValueOnce(Option.none());
			const response = await makeDashboardHttp(deps).detail(request(`/api/boards/${id}`), id);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: { code: "not_found" } });
			expect(deps.get).toHaveBeenCalledWith("user-1", id);
		}
	});

	test("rejects malformed board identifiers as the same uncached 404 without database access", async () => {
		for (const id of ["not-a-uuid", "", "01956d31-c55b", "x".repeat(500)]) {
			const deps = dependencies();
			const response = await makeDashboardHttp(deps).detail(request(), id);
			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toEqual({ error: { code: "not_found" } });
			expect(deps.get).not.toHaveBeenCalled();
		}
	});

	test("requires same-origin JSON and a bounded idempotency key for creation", async () => {
		const invalidRequests = [
			request("/api/boards", {
				method: "POST",
				headers: { origin: "https://evil.example", "content-type": "application/json", "idempotency-key": "key" },
				body: JSON.stringify({ name: "Board" }),
			}),
			request("/api/boards", {
				method: "POST",
				headers: { origin: "https://cloud.chirp.wiki", "content-type": "application/json" },
				body: JSON.stringify({ name: "Board" }),
			}),
			request("/api/boards", {
				method: "POST",
				headers: {
					origin: "https://cloud.chirp.wiki",
					"content-type": "application/json",
					"idempotency-key": "key",
				},
				body: JSON.stringify({ name: "Board", owner_id: "user-2" }),
			}),
			request("/api/boards", {
				method: "POST",
				headers: {
					origin: "https://cloud.chirp.wiki",
					"content-type": "application/json",
					"idempotency-key": "key",
				},
				body: JSON.stringify({ name: "Board", storage_engine: "postgres" }),
			}),
		];
		for (const [index, invalid] of invalidRequests.entries()) {
			const deps = dependencies();
			const response = await makeDashboardHttp(deps).create(invalid);
			expect(response.status).toBe(index === 0 ? 403 : 400);
			expect(deps.create).not.toHaveBeenCalled();
		}
	});

	test("uses the configured public origin behind a proxy and rejects request-derived origins", async () => {
		for (const [origin, status] of [
			["https://cloud.chirp.wiki", 201],
			["http://127.0.0.1:3000", 403],
			["null", 403],
		] as const) {
			const deps = dependencies();
			const response = await makeDashboardHttp(deps).create(
				new Request("http://127.0.0.1:3000/api/boards", {
					method: "POST",
					headers: { origin, "content-type": "application/json", "idempotency-key": "key" },
					body: JSON.stringify({ name: "Board" }),
				}),
			);
			expect(response.status).toBe(status);
			expect(deps.create).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
		}
	});

	test("rejects an undeclared oversized body before dashboard work", async () => {
		const deps = dependencies();
		const response = await makeDashboardHttp(deps).create(
			request("/api/boards", {
				method: "POST",
				headers: {
					origin: "https://cloud.chirp.wiki",
					"content-type": "application/json",
					"idempotency-key": "key",
				},
				body: JSON.stringify({ name: "x".repeat(5_000) }),
			}),
		);
		expect(response.status).toBe(400);
		expect(deps.create).not.toHaveBeenCalled();
	});

	test("creates managed SQLite through the session owner and returns a detail location", async () => {
		const deps = dependencies();
		const response = await makeDashboardHttp(deps).create(
			request("/api/boards", {
				method: "POST",
				headers: {
					origin: "https://cloud.chirp.wiki",
					"content-type": "application/json",
					"idempotency-key": "create-key",
				},
				body: JSON.stringify({ name: "  Board  " }),
			}),
		);
		expect(response.status).toBe(201);
		expect(response.headers.get("location")).toBe("/boards/board-1");
		expect(deps.create).toHaveBeenCalledWith("user-1", {
			name: "  Board  ",
			idempotency_key: "create-key",
		});
		expect(await response.json()).toEqual({ board });
	});

	test("maps idempotency conflicts and runtime failures to typed, redacted errors", async () => {
		const conflict = dependencies();
		conflict.create.mockResolvedValueOnce({ ok: false, code: "idempotency_conflict" });
		const init: RequestInit = {
			method: "POST",
			headers: {
				origin: "https://cloud.chirp.wiki",
				"content-type": "application/json",
				"idempotency-key": "create-key",
			},
			body: JSON.stringify({ name: "Board" }),
		};
		const conflictResponse = await makeDashboardHttp(conflict).create(request("/api/boards", init));
		expect(conflictResponse.status).toBe(409);
		expect(await conflictResponse.json()).toEqual({ error: { code: "idempotency_conflict" } });

		const quota = dependencies();
		quota.create.mockResolvedValueOnce({ ok: false, code: "board_quota_exceeded" });
		const quotaResponse = await makeDashboardHttp(quota).create(request("/api/boards", init));
		expect(quotaResponse.status).toBe(403);
		expect(quotaResponse.headers.get("cache-control")).toBe("no-store");
		expect(await quotaResponse.json()).toEqual({ error: { code: "board_quota_exceeded" } });

		const unavailable = dependencies();
		unavailable.list.mockRejectedValueOnce(new Error("secret database detail"));
		const unavailableResponse = await makeDashboardHttp(unavailable).list(request());
		expect(unavailableResponse.status).toBe(503);
		expect(await unavailableResponse.text()).not.toContain("secret database detail");
	});
});
