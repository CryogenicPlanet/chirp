import { describe, expect, test, vi } from "vitest";
import { makeInvitationHttp } from "../src/invitation-http.ts";

const user = { id: "operator-1", name: "Owner", email: "owner@example.com" };
const dependencies = () => ({
	getSession: vi.fn(async (): Promise<{ session: { user: typeof user } | null; headers: Headers }> => ({
		session: { user },
		headers: new Headers({ "set-cookie": "renewed=yes; HttpOnly" }),
	})),
	getPublicOrigin: vi.fn(async () => "https://cloud.test"),
	canInvite: vi.fn(async () => true),
	invite: vi.fn(
		async (): Promise<
			| { readonly ok: true; readonly token: string; readonly expires_at: string }
			| { readonly ok: false; readonly code: "invalid_request" | "invitations_forbidden" | "invitation_rate_limited" }
		> => ({ ok: true, token: "a".repeat(43), expires_at: "2026-09-22T00:00:00.000Z" }),
	),
});
const request = (body: unknown = { email: "person@example.com" }, origin: string | null = "https://cloud.test") =>
	new Request("http://localhost:3000/api/invitations", {
		method: "POST",
		headers: { "content-type": "application/json", ...(origin === null ? {} : { origin }) },
		body: JSON.stringify(body),
	});

describe("invitation HTTP", () => {
	test("requires authentication for capability and issuance", async () => {
		const deps = dependencies();
		deps.getSession.mockResolvedValue({ session: null, headers: new Headers() });
		const http = makeInvitationHttp(deps);
		expect((await http.capability(request())).status).toBe(401);
		expect((await http.create(request())).status).toBe(401);
		expect(deps.canInvite).not.toHaveBeenCalled();
		expect(deps.invite).not.toHaveBeenCalled();
	});

	test("reports capability from the session email and denies nonoperators", async () => {
		const deps = dependencies();
		deps.canInvite.mockResolvedValue(false);
		const http = makeInvitationHttp(deps);
		const capability = await http.capability(request());
		expect(await capability.json()).toEqual({ can_invite: false });
		expect(capability.headers.get("cache-control")).toBe("no-store");
		expect(deps.canInvite).toHaveBeenCalledWith(user.email);
		expect((await http.create(request())).status).toBe(403);
		expect(deps.invite).not.toHaveBeenCalled();
	});

	test.each([null, "null", "http://localhost:3000", "https://evil.test"])(
		"rejects untrusted origin %s",
		async (origin) => {
			const deps = dependencies();
			const response = await makeInvitationHttp(deps).create(request(undefined, origin));
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: { code: "origin_rejected" } });
			expect(deps.invite).not.toHaveBeenCalled();
		},
	);

	test.each([
		{ email: "bad" },
		{ email: "a@@b.com" },
		{ email: "a@b.com", issuer_id: "other" },
		{ email: "a".repeat(5_000) },
		null,
	])("rejects invalid or oversized input", async (body) => {
		const deps = dependencies();
		expect((await makeInvitationHttp(deps).create(request(body))).status).toBe(400);
		expect(deps.invite).not.toHaveBeenCalled();
	});

	test("issues through session identity and returns the one-time fragment URL without caching", async () => {
		const deps = dependencies();
		const response = await makeInvitationHttp(deps).create(request());
		expect(response.status).toBe(201);
		expect(response.headers.get("set-cookie")).toBe("renewed=yes; HttpOnly");
		expect(deps.invite).toHaveBeenCalledWith({ id: user.id, email: user.email }, "person@example.com");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			url: `https://cloud.test/invite#${"a".repeat(43)}`,
			expires_at: "2026-09-22T00:00:00.000Z",
		});
	});

	test("maps quota and backend errors without exposing sensitive details", async () => {
		const deps = dependencies();
		deps.invite.mockResolvedValueOnce({ ok: false, code: "invitation_rate_limited" });
		const http = makeInvitationHttp(deps);
		const limited = await http.create(request());
		expect(limited.status).toBe(429);
		expect(limited.headers.get("set-cookie")).toBe("renewed=yes; HttpOnly");
		expect(await limited.json()).toEqual({ error: { code: "invitation_rate_limited" } });
		deps.invite.mockRejectedValueOnce(new Error("sensitive token"));
		const failed = await http.create(request());
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("sensitive token");
	});
});
