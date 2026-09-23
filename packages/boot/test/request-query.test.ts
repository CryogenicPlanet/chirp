import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { requestQuery } from "../src/request-query.ts";

const opaque = () => randomBytes(32).toString("base64url");

it("keeps the readable OAuth authorization parameters an agent needs and redacts state and challenge", () => {
	const state = opaque(),
		challenge = opaque(),
		client = `mcp_client_${randomBytes(24).toString("base64url")}`;
	const search = new URLSearchParams({
		response_type: "code",
		client_id: client,
		redirect_uri: "https://claude.ai/api/mcp/auth_callback",
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		scope: "chirp",
		resource: "https://chirp.cryo.wtf/mcp",
	});
	const recorded = requestQuery(`?${search}`);
	expect(recorded).toEqual({
		query: [
			["response_type", "code"],
			["client_id", client],
			["redirect_uri", "https://claude.ai/api/mcp/auth_callback"],
			["code_challenge", "[redacted]"],
			["code_challenge_method", "S256"],
			["state", "[redacted]"],
			["scope", "chirp"],
			["resource", "https://chirp.cryo.wtf/mcp"],
		],
	});
	for (const secret of [state, challenge]) expect(JSON.stringify(recorded)).not.toContain(secret);
});

it("never stores values of credential names, including word, camelCase and joined variants", () => {
	const names = [
		"code",
		"code_verifier",
		"state",
		"token",
		"access_token",
		"refresh_token",
		"id_token",
		"client_secret",
		"password",
		"secret",
		"key",
		"signature",
		"sig",
		"assertion",
		"credential",
		"session",
		"cookie",
		"device_secret",
		"user_code",
		"nonce",
		"accessToken",
		"apiKey",
		"api-key",
		"X-Amz-Signature",
		"X-Amz-Credential",
		"clientsecret",
		"passkey_code",
		"setup_code",
		"otp",
		"session_state",
		"authorization",
	];
	// Short readable values prove the name alone causes redaction.
	const recorded = requestQuery(`?${names.map((name, index) => `${name}=v${index}x`).join("&")}`);
	expect(recorded.query?.map(([name]) => name)).toEqual(names);
	expect(recorded.query?.every(([, value]) => value === "[redacted]")).toBe(true);
	expect(JSON.stringify(recorded)).not.toMatch(/v\d+x/);
});

it("redacts key- and token-shaped values and names under names it cannot recognize", () => {
	const values = [
		opaque(),
		randomBytes(32).toString("hex"),
		randomBytes(16).toString("base64url"),
		`chirp_app_${opaque()}`,
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
		"0123456789ab-0123456789abcdef",
	];
	const bare = opaque();
	const recorded = requestQuery(`?${values.map((value, index) => `p${index}=${value}`).join("&")}&${bare}`);
	expect(recorded.query).toEqual([...values.map((_, index) => [`p${index}`, "[redacted]"]), ["[redacted]", ""]]);
	for (const value of [...values, bare]) expect(JSON.stringify(recorded)).not.toContain(value);
	expect(requestQuery("?topic=project/thread&limit=50&q=why+did+it+fail").query).toEqual([
		["topic", "project/thread"],
		["limit", "50"],
		["q", "why did it fail"],
	]);
});

it("removes nested queries, fragments and userinfo from URL values, even for public OAuth names", () => {
	const secret = opaque();
	const recorded = requestQuery(
		`?${new URLSearchParams({
			next: `/mcp/oauth/authorize?state=${secret}&resource=x`,
			redirect_uri: `https://alice:${secret}@example.com/callback#access_token=${secret}`,
			resource: `https://chirp.test/mcp?key=${secret}`,
		})}`,
	);
	expect(recorded.query).toEqual([
		["next", "/mcp/oauth/authorize?[redacted]"],
		["redirect_uri", "https://[redacted]@example.com/callback#[redacted]"],
		["resource", "https://chirp.test/mcp?[redacted]"],
	]);
	expect(JSON.stringify(recorded)).not.toContain(secret);
});

it("removes short userinfo from scheme-relative, backslashed and @-containing URL values", () => {
	const recorded = requestQuery(
		`?${new URLSearchParams({
			next: "//alice:hunter2@example.com/private",
			target: String.raw`https:\\bob:pa@ss9@example.com/x`,
			back: String.raw`/\carol:tulip7@example.com`,
			triple: "https:///dave:hunter2@example.com",
			relative: "///erin:hunter2@example.com",
			bare: "https:frank:hunter2@example.com/private",
			single: "https:/grace:hunter2@example.com/private",
			tabbed: "ht\ttps://heidi:hunter2@example.com",
			email: "rahul@example.com",
			mailto: "mailto:rahul@example.com",
		})}`,
	);
	expect(recorded.query).toEqual([
		["next", "//[redacted]@example.com/private"],
		["target", String.raw`https:\\[redacted]@example.com/x`],
		["back", String.raw`/\[redacted]@example.com`],
		["triple", "https:///[redacted]@example.com"],
		["relative", "///[redacted]@example.com"],
		// The URL parser reads these as userinfo too, so nothing of them is kept.
		["bare", "[redacted]"],
		["single", "[redacted]"],
		["tabbed", "[redacted]"],
		["email", "rahul@example.com"],
		["mailto", "mailto:rahul@example.com"],
	]);
	for (const password of ["hunter2", "pa@ss9", "ss9", "tulip7", "dave", "erin", "frank", "grace", "heidi"])
		expect(JSON.stringify(recorded)).not.toContain(password);
});

it("bounds parameter count, name and value length and total size", () => {
	expect(requestQuery("")).toEqual({});
	expect(requestQuery("?")).toEqual({});
	const many = requestQuery(`?${Array.from({ length: 40 }, (_, index) => `n${index}=v`).join("&")}`);
	expect(many.query).toHaveLength(32);
	expect(many.query_truncated).toBe(true);
	const long = requestQuery(`?${"n".repeat(100)}=${"word ".repeat(100)}`).query?.[0];
	expect(long?.[0]).toBe(`${"n".repeat(64)}…`);
	expect(long?.[1]).toHaveLength(257);
	const large = requestQuery(
		`?${Array.from({ length: 20 }, (_, index) => `n${index}=${"word ".repeat(60)}`).join("&")}`,
	);
	expect(large.query_truncated).toBe(true);
	expect(JSON.stringify(large.query).length).toBeLessThan(2400);
	expect(large.query?.length).toBeLessThan(20);
});
