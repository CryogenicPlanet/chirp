import { describe, expect, test } from "vitest";
import { dashboardErrorMessage, readDashboardResponse } from "../../src/app/dashboard-response.ts";
import { DashboardBoardResponse, DashboardBoardsResponse } from "../../src/dashboard-contract.ts";

describe("dashboard response boundary", () => {
	test("maps malformed list, create and detail payloads to a safe human-facing error", async () => {
		for (const body of ['{"board":{"internal":"private diagnostic"}}', "not JSON"]) {
			await expect(readDashboardResponse(new Response(body), DashboardBoardResponse)).rejects.toThrow(
				/^Chirp Cloud is temporarily unavailable\.$/,
			);
			await expect(readDashboardResponse(new Response(body), DashboardBoardsResponse)).rejects.toThrow(
				/^Chirp Cloud is temporarily unavailable\.$/,
			);
		}
		expect(dashboardErrorMessage(new Error("raw Effect diagnostic"))).toBe("Chirp Cloud is temporarily unavailable.");
	});

	test("preserves validated responses", async () => {
		expect(
			await readDashboardResponse(Response.json({ boards: [], truncated: false }), DashboardBoardsResponse),
		).toEqual({ boards: [], truncated: false });
	});

	test("shows actionable status and quota errors without rendering the server body", async () => {
		for (const [status, message] of [
			[401, "Your session expired. Sign in again to continue."],
			[404, "This board was not found."],
			[409, "That request key was already used for different board details."],
			[503, "Chirp Cloud is temporarily unavailable."],
		] as const) {
			const cause = await readDashboardResponse(
				new Response("private diagnostic", { status }),
				DashboardBoardResponse,
			).catch((error: unknown) => error);
			expect(dashboardErrorMessage(cause)).toBe(message);
		}
		await expect(
			readDashboardResponse(
				Response.json({ error: { code: "board_quota_exceeded" } }, { status: 403 }),
				DashboardBoardResponse,
			),
		).rejects.toThrow("Your account has reached its board limit. Contact support for help.");
		await expect(
			readDashboardResponse(
				Response.json({ error: { code: "origin_rejected" } }, { status: 403 }),
				DashboardBoardResponse,
			),
		).rejects.toThrow("This page could not be verified. Reload Chirp Cloud and try again.");
		for (const [code, message] of [
			["invalid_postgres_url", "Enter a valid public PostgreSQL administrator URL and try again."],
			[
				"postgres_channel_binding_unsupported",
				"This PostgreSQL driver can't enforce channel_binding=require. Remove that parameter and keep verified TLS enabled.",
			],
			["postgres_unavailable", "PostgreSQL board creation is not available on this Cloud instance."],
		] as const)
			await expect(
				readDashboardResponse(Response.json({ error: { code } }, { status: 400 }), DashboardBoardResponse),
			).rejects.toThrow(message);
	});
});
