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
const dependencies = () => ({
	getSession: vi.fn(async (): Promise<typeof session | null> => session),
	list: vi.fn(async () => [board]),
	get: vi.fn(async () => Option.some(board)),
	create: vi.fn(
		async (): Promise<
			| { readonly ok: true; readonly board: DashboardBoard }
			| { readonly ok: false; readonly code: "idempotency_conflict" | "invalid_request" | "unavailable" }
		> => ({ ok: true, board }),
	),
});

const request = (path = "/api/boards", init?: RequestInit) => new Request(`https://cloud.chirp.wiki${path}`, init);

describe("dashboard HTTP", () => {
	test("rejects unauthenticated reads before accessing dashboard data", async () => {
		const deps = dependencies();
		deps.getSession.mockResolvedValueOnce(null);
		const response = await makeDashboardHttp(deps).list(request());
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
		expect(deps.list).not.toHaveBeenCalled();
	});

	test("lists only through the authenticated owner identity", async () => {
		const deps = dependencies();
		const response = await makeDashboardHttp(deps).list(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(deps.list).toHaveBeenCalledWith("user-1");
		expect(await response.json()).toEqual({ boards: [board] });
	});

	test("returns the same 404 for missing and foreign board identifiers", async () => {
		const deps = dependencies();
		deps.get.mockResolvedValueOnce(Option.none());
		const response = await makeDashboardHttp(deps).detail(request("/api/boards/foreign"), "foreign");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: { code: "not_found" } });
		expect(deps.get).toHaveBeenCalledWith("user-1", "foreign");
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
		for (const invalid of invalidRequests) {
			const deps = dependencies();
			const response = await makeDashboardHttp(deps).create(invalid);
			expect([400, 403]).toContain(response.status);
			expect(deps.create).not.toHaveBeenCalled();
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

		const unavailable = dependencies();
		unavailable.list.mockRejectedValueOnce(new Error("secret database detail"));
		const unavailableResponse = await makeDashboardHttp(unavailable).list(request());
		expect(unavailableResponse.status).toBe(503);
		expect(await unavailableResponse.text()).not.toContain("secret database detail");
	});
});
