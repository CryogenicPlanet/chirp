import { expect, it } from "vitest";
import {
	authorizeQuery,
	boardRedirect,
	cookieName,
	csrfOf,
	github,
	issuer,
	location,
	postConsent,
	s256,
	signIn,
	throughUpstream,
	transactionCookie,
	verifier,
	withHarness,
} from "./fixtures/signin.ts";

const challenge = s256(verifier());

it(
	"hands a valid request to GitHub with its own state and PKCE, in a __Host- transaction cookie",
	withHarness(async (h) => {
		const response = await h.request(authorizeQuery(h.clients.board(), challenge));
		expect(response.status).toBe(303);
		const upstream = location(response);
		expect(`${upstream.origin}${upstream.pathname}`).toBe(h.upstream.endpoints.github.authorize);
		expect(Object.fromEntries(upstream.searchParams)).toEqual({
			client_id: github.clientId,
			redirect_uri: `${issuer}/callback/github`,
			state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			code_challenge_method: "S256",
		});
		// The board's state and challenge never reach the upstream.
		expect(upstream.searchParams.get("state")).not.toBe("board-state");
		expect(upstream.searchParams.get("code_challenge")).not.toBe(challenge);
		const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`)) ?? "";
		expect(cookie).toMatch(/; Max-Age=600/);
		expect(cookie).toMatch(/; Path=\//);
		expect(cookie).toMatch(/; HttpOnly/);
		expect(cookie).toMatch(/; Secure/);
		expect(cookie).toMatch(/; SameSite=Lax/);
		expect(cookie).not.toMatch(/Domain=/i);
	}),
);

it(
	"asks Google for openid email and sends no upstream nonce",
	withHarness(async (h) => {
		const upstream = location(await h.request(authorizeQuery(h.clients.board(), challenge, { provider: "google" })));
		expect(upstream.searchParams.get("scope")).toBe("openid email");
		expect(upstream.searchParams.get("response_type")).toBe("code");
		expect(upstream.searchParams.has("nonce")).toBe(false);
		expect(upstream.searchParams.get("redirect_uri")).toBe(`${issuer}/callback/google`);
	}),
);

it.each([
	["no client_id", { client_id: null }, "client_id"],
	["no redirect_uri", { redirect_uri: null }, "redirect_uri"],
	["an unlisted redirect_uri", { redirect_uri: "https://evil.test/auth/oidc/callback" }, "not listed"],
	["an http redirect_uri", { redirect_uri: "http://board.test/auth/oidc/callback" }, "https"],
	["an unreachable client document", { client_id: "http://localhost:9/client.json" }, "could not be fetched"],
] as const)("renders a page and never redirects for %s", (_name, overrides, message) =>
	withHarness(async (h) => {
		const response = await h.request(authorizeQuery(h.clients.board(), challenge, overrides));
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await response.text()).toContain(message);
	})(),
);

it(
	"renders a page for a duplicated parameter, even a redirect_uri",
	withHarness(async (h) => {
		const query = `${authorizeQuery(h.clients.board(), challenge)}&redirect_uri=${encodeURIComponent("https://evil.test/cb")}`;
		const response = await h.request(query);
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	}),
);

it.each([
	["code_challenge_method plain", { code_challenge_method: "plain" }, "invalid_request"],
	["no code_challenge_method", { code_challenge_method: null }, "invalid_request"],
	["no code_challenge", { code_challenge: null }, "invalid_request"],
	["a malformed code_challenge", { code_challenge: "short" }, "invalid_request"],
	["no nonce", { nonce: null }, "invalid_request"],
	["an unknown provider", { provider: "gitlab" }, "invalid_request"],
	["no provider", { provider: null }, "invalid_request"],
	["a token response_type", { response_type: "token" }, "unsupported_response_type"],
	["a scope without openid", { scope: "email" }, "invalid_scope"],
] as const)("redirects %s back to the board with error, state and iss", (_name, overrides, error) =>
	withHarness(async (h) => {
		const response = await h.request(authorizeQuery(h.clients.board(), challenge, overrides));
		expect(response.status).toBe(303);
		const back = location(response);
		expect(`${back.origin}${back.pathname}`).toBe(boardRedirect);
		expect(Object.fromEntries(back.searchParams)).toEqual({ error, state: "board-state", iss: issuer });
		expect(transactionCookie(response)).toBe("");
	})(),
);

it(
	"shows consent naming the board origin and account, with a CSP that only lets the form reach the board",
	withHarness(async (h) => {
		const { callback } = await throughUpstream(h);
		expect(callback.status).toBe(200);
		expect(callback.headers.get("content-security-policy")).toBe(
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://board.test; frame-ancestors 'none'; base-uri 'none'",
		);
		expect(callback.headers.get("referrer-policy")).toBe("same-origin");
		expect(callback.headers.get("cache-control")).toBe("no-store");
		const page = await callback.text();
		// The harness serves the client document from localhost, so the page names who registered the callback.
		const registrant = new URL(h.clients.url("/")).host;
		expect(page).toContain(`Sign in to https://board.test (registered by ${registrant}) as octocat on GitHub?`);
		expect(page).toContain("It will receive your GitHub account id and username.");
		expect(page).not.toContain("<script");
		// The upstream exchange used the verifier behind the challenge it was sent.
		const exchange = h.upstream.requests.find((request) => request.path === "/github/token");
		expect(exchange?.params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
	}),
);

it(
	"refuses a callback without the transaction cookie, with a foreign state, or for the other provider",
	withHarness(async (h) => {
		const authorized = await h.request(authorizeQuery(h.clients.board(), challenge));
		const cookie = transactionCookie(authorized);
		const state = location(authorized).searchParams.get("state") ?? "";
		const attempts = [
			h.request(`/callback/github?code=x&state=${state}`),
			h.request(`/callback/github?code=x&state=${state}`, {
				headers: { cookie: `${cookieName}=${cookie}; ${cookieName}=${cookie}` },
			}),
			h.request(`/callback/github?code=x&state=forged`, { headers: { cookie: `${cookieName}=${cookie}` } }),
			h.request(`/callback/google?code=x&state=${state}`, { headers: { cookie: `${cookieName}=${cookie}` } }),
			h.request(`/callback/github?code=x&state=${state}`, { headers: { cookie: `${cookieName}=${cookie}x` } }),
		];
		for (const response of await Promise.all(attempts)) {
			expect(response.status).toBe(400);
			expect(response.headers.get("location")).toBeNull();
		}
		expect(h.upstream.requests.filter((request) => request.path === "/github/token")).toEqual([]);
	}),
);

it(
	"returns access_denied when the person cancels upstream, and server_error when the exchange fails",
	withHarness(async (h) => {
		const authorized = await h.request(authorizeQuery(h.clients.board(), challenge));
		const cookie = transactionCookie(authorized);
		const state = location(authorized).searchParams.get("state") ?? "";
		const cancelled = await h.request(`/callback/github?error=access_denied&state=${state}`, {
			headers: { cookie: `${cookieName}=${cookie}` },
		});
		expect(Object.fromEntries(location(cancelled).searchParams)).toEqual({
			error: "access_denied",
			state: "board-state",
			iss: issuer,
		});
		h.upstream.profile.refuseToken = true;
		const failed = await throughUpstream(h);
		expect(failed.callback.status).toBe(303);
		expect(location(failed.callback).searchParams.get("error")).toBe("server_error");
	}),
);

it(
	"refuses a consent POST without the issuer Origin or the page's CSRF token",
	withHarness(async (h) => {
		const { callback, cookie } = await throughUpstream(h);
		const csrf = await csrfOf(callback);
		const refusals = await Promise.all([
			postConsent(h, cookie, { csrf, decision: "continue" }, null),
			postConsent(h, cookie, { csrf, decision: "continue" }, "null"),
			postConsent(h, cookie, { csrf, decision: "continue" }, "https://board.boards.chirp.wiki"),
			postConsent(h, cookie, { decision: "continue" }),
			postConsent(h, cookie, { csrf: `${csrf.slice(0, -1)}A`, decision: "continue" }),
			postConsent(h, undefined, { csrf, decision: "continue" }),
		]);
		expect(refusals.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 400]);
		for (const response of refusals) expect(response.headers.get("location")).toBeNull();
		// A cookie still at the upstream stage cannot be consented to.
		const early = await h.request(authorizeQuery(h.clients.board(), challenge));
		expect((await postConsent(h, transactionCookie(early), { csrf, decision: "continue" })).status).toBe(400);
	}),
);

it(
	"redirects a cancelled consent with access_denied and clears the cookie",
	withHarness(async (h) => {
		const { callback, cookie } = await throughUpstream(h);
		const response = await postConsent(h, cookie, { csrf: await csrfOf(callback), decision: "cancel" });
		expect(response.status).toBe(303);
		expect(Object.fromEntries(location(response).searchParams)).toEqual({
			error: "access_denied",
			state: "board-state",
			iss: issuer,
		});
		expect(transactionCookie(response)).toBe("");
	}),
);

it(
	"continues with a code, the board's state and iss",
	withHarness(async (h) => {
		const { back } = await signIn(h);
		expect([...back.searchParams.keys()].sort()).toEqual(["code", "iss", "state"]);
		expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]+$/);
	}),
);
