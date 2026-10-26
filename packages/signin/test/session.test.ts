import { Duration } from "effect";
import { decodeJwt } from "jose";
import { expect, it } from "vitest";
import {
	authorizeQuery,
	boardRedirect,
	csrfOf,
	type Harness,
	issuer,
	location,
	s256,
	token,
	transactionCookie,
	verifier,
	withHarness,
} from "./fixtures/signin.ts";

type Provider = "github" | "google";
const sessionCookie = (provider: Provider) => `__Host-signin.${provider}`;

/** One browser: its cookies go out with every request and Set-Cookie comes back, Max-Age=0 deleting. */
const browser = (h: Harness) => {
	const jar = new Map<string, string>();
	const take = (response: Response) => {
		for (const line of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
			const name = pair.slice(0, pair.indexOf("="));
			if (attributes.includes("Max-Age=0")) jar.delete(name);
			else jar.set(name, pair.slice(name.length + 1));
		}
		return response;
	};
	const visit = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		take(
			await h.request(path, {
				...init,
				headers: { ...init.headers, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") },
			}),
		);
	/** The board's redirect to /authorize, with the verifier the board keeps. */
	const authorize = async (clientId: string, overrides: Record<string, string> = {}) => {
		const boardVerifier = verifier();
		return { response: await visit(authorizeQuery(clientId, s256(boardVerifier), overrides)), boardVerifier };
	};
	/** Follow a redirect to the fake provider and back to the callback. */
	const throughProvider = async (response: Response) => {
		const back = location(await fetch(location(response), { redirect: "manual" }));
		return visit(`${back.pathname}${back.search}`);
	};
	const decide = async (page: Response, decision: "continue" | "cancel") =>
		visit("/consent", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: issuer },
			body: new URLSearchParams({ csrf: await csrfOf(page), decision }).toString(),
		});
	/** A sign-in with no session: the provider, then Continue. */
	const signIn = async (clientId: string, overrides: Record<string, string> = {}) => {
		const { response, boardVerifier } = await authorize(clientId, overrides);
		const consent = await decide(await throughProvider(response), "continue");
		return { consent, boardVerifier, code: location(consent).searchParams.get("code") ?? "" };
	};
	return { jar, visit, authorize, throughProvider, decide, signIn };
};

const toProvider = (h: Harness, response: Response, provider: Provider = "github") => {
	expect(response.status).toBe(303);
	const upstream = location(response);
	expect(`${upstream.origin}${upstream.pathname}`).toBe(h.upstream.endpoints[provider].authorize);
};
const toBoard = (response: Response, redirectUri = boardRedirect) => {
	expect(response.status).toBe(303);
	const back = location(response);
	expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
	expect([...back.searchParams.keys()].sort()).toEqual(["code", "iss", "state"]);
	expect(back.searchParams.get("iss")).toBe(issuer);
	expect(back.searchParams.get("state")).toBe("board-state");
	return back.searchParams.get("code") ?? "";
};
const toConsent = async (response: Response) => {
	expect(response.status).toBe(200);
	expect(await response.clone().text()).toContain('action="/consent"');
};

const redeem = async (h: Harness, clientId: string, code: string, boardVerifier: string) => {
	const response = await token(h, {
		grant_type: "authorization_code",
		code,
		redirect_uri: boardRedirect,
		client_id: clientId,
		code_verifier: boardVerifier,
	});
	expect(response.status).toBe(200);
	return decodeJwt((await response.json()).id_token);
};

it(
	"signs in to a board it already approved with a silent redirect that keeps the first sign-in's auth_time",
	withHarness(async (h) => {
		const b = browser(h);
		const clientId = h.clients.board();
		const first = await b.signIn(clientId);
		const cookie = first.consent.headers.getSetCookie().find((line) => line.startsWith(`${sessionCookie("github")}=`));
		expect(cookie).toMatch(/; Max-Age=(2591999|2592000);/);
		expect(cookie).toMatch(/; Path=\//);
		expect(cookie).toMatch(/; HttpOnly/);
		expect(cookie).toMatch(/; Secure/);
		expect(cookie).toMatch(/; SameSite=Lax/);
		expect(cookie).not.toMatch(/Domain=/i);
		const firstToken = await redeem(h, clientId, first.code, first.boardVerifier);

		const calls = h.upstream.requests.length;
		h.advance(Duration.days(1));
		const again = await b.authorize(clientId);
		const code = toBoard(again.response);
		expect(again.response.headers.get("cache-control")).toBe("no-store");
		expect(again.response.headers.getSetCookie()).toEqual([]);
		expect(h.upstream.requests.length).toBe(calls);
		const secondToken = await redeem(h, clientId, code, again.boardVerifier);
		expect(secondToken.sub).toBe("github:4242");
		expect(secondToken.preferred_username).toBe("octocat");
		expect(secondToken.nonce).toBe("board-nonce");
		expect(secondToken.auth_time).toBe(firstToken.auth_time);
		expect(Number(secondToken.iat) - Number(firstToken.iat)).toBeGreaterThanOrEqual(86_400);
	}),
);

it(
	"asks once, without the provider, for a board the session has not approved, and goes to the provider for the other provider",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		const other = h.clients.board("/other/client.json");
		await b.signIn(board);
		const calls = h.upstream.requests.length;

		const asked = await b.authorize(other);
		await toConsent(asked.response);
		const page = await asked.response.clone().text();
		expect(page).toContain("as octocat on GitHub?");
		expect(page).toContain("without asking again for up to 30 days");
		const code = toBoard(await b.decide(asked.response, "continue"));
		expect((await redeem(h, other, code, asked.boardVerifier)).sub).toBe("github:4242");
		expect(h.upstream.requests.length).toBe(calls);

		// Both boards are now remembered, newest first.
		toBoard((await b.authorize(other)).response);
		toBoard((await b.authorize(board)).response);
		expect(h.upstream.requests.length).toBe(calls);
		toProvider(h, (await b.authorize(board, { provider: "google" })).response, "google");
	}),
);

it(
	"asks again when the same client sends the person to a redirect origin it has not approved",
	withHarness(async (h) => {
		const b = browser(h);
		const elsewhere = "https://other.test/auth/oidc/callback";
		const clientId = h.clients.board("/auth/oidc/client.json", { redirect_uris: [boardRedirect, elsewhere] });
		await b.signIn(clientId);
		const asked = await b.authorize(clientId, { redirect_uri: elsewhere });
		await toConsent(asked.response);
		expect(asked.response.headers.get("content-security-policy")).toContain("form-action 'self' https://other.test;");
		toBoard(await b.decide(asked.response, "continue"), elsewhere);
		toBoard((await b.authorize(clientId, { redirect_uri: elsewhere })).response, elsewhere);
	}),
);

it(
	"remembers nothing when the person cancels",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		const other = h.clients.board("/other/client.json");
		await b.signIn(board);
		const session = b.jar.get(sessionCookie("github"));
		const cancelled = await b.decide((await b.authorize(other)).response, "cancel");
		expect(location(cancelled).searchParams.get("error")).toBe("access_denied");
		expect(cancelled.headers.getSetCookie().filter((line) => line.startsWith("__Host-signin.github"))).toEqual([]);
		expect(b.jar.get(sessionCookie("github"))).toBe(session);
		await toConsent((await b.authorize(other)).response);
		toBoard((await b.authorize(board)).response);
	}),
);

it(
	"starts a new list when another account continues",
	withHarness(async (h) => {
		const first = browser(h);
		const board = h.clients.board();
		const other = h.clients.board("/other/client.json");
		await first.signIn(board);
		// A tab that went to GitHub before the session existed comes back as another account.
		const tab = browser(h);
		const started = await tab.authorize(other);
		h.upstream.profile.github = { id: 99, login: "hubot" };
		const page = await tab.throughProvider(started.response);
		tab.jar.set(sessionCookie("github"), first.jar.get(sessionCookie("github")) ?? "");
		const code = toBoard(await tab.decide(page, "continue"));
		expect((await redeem(h, other, code, started.boardVerifier)).sub).toBe("github:99");

		const silent = await tab.authorize(other);
		expect((await redeem(h, other, toBoard(silent.response), silent.boardVerifier)).sub).toBe("github:99");
		const asked = await tab.authorize(board);
		await toConsent(asked.response);
		expect(await asked.response.text()).toContain("as hubot on GitHub?");
	}),
);

it(
	"ends the session 30 days after the provider sign-in, however it was used since",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		const other = h.clients.board("/other/client.json");
		const first = await b.signIn(board);
		const auth = (await redeem(h, board, first.code, first.boardVerifier)).auth_time;
		h.advance(Duration.days(20));
		// Consenting through the session at day 20 does not extend it.
		const asked = await b.authorize(other);
		const code = toBoard(await b.decide(asked.response, "continue"));
		expect((await redeem(h, other, code, asked.boardVerifier)).auth_time).toBe(auth);
		h.advance(Duration.days(9));
		h.advance(Duration.hours(23));
		toBoard((await b.authorize(board)).response);
		h.advance(Duration.hours(1));
		toProvider(h, (await b.authorize(board)).response);
		toProvider(h, (await b.authorize(other)).response);
	}),
);

it(
	"treats a tampered, duplicated, foreign-purpose or other provider's cookie as no session",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		const { code } = await b.signIn(board);
		const session = b.jar.get(sessionCookie("github")) ?? "";
		const flipped = `${session.slice(0, 20)}${session[20] === "A" ? "B" : "A"}${session.slice(21)}`;
		const transaction = transactionCookie(await h.request(authorizeQuery(board, s256(verifier())))) ?? "";
		const github = sessionCookie("github");
		const attempts: ReadonlyArray<readonly [Provider, string]> = [
			["github", `${github}=${flipped}`],
			["github", `${github}=${session}; ${github}=${session}`],
			["github", `${github}=${transaction}`],
			["github", `${github}=${code}`],
			["google", `${sessionCookie("google")}=${session}`],
		];
		for (const [provider, cookie] of attempts) {
			const response = await h.request(authorizeQuery(board, s256(verifier()), { provider }), {
				headers: { cookie },
			});
			toProvider(h, response, provider);
		}
		// The genuine cookie still answers.
		toBoard(await h.request(authorizeQuery(board, s256(verifier())), { headers: { cookie: `${github}=${session}` } }));
	}),
);

it(
	"never lets a session skip the redirect_uri check",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		await b.signIn(board);
		const calls = h.upstream.requests.length;
		for (const redirectUri of ["https://evil.test/auth/oidc/callback", "http://board.test/auth/oidc/callback"]) {
			const response = (await b.authorize(board, { redirect_uri: redirectUri })).response;
			expect(response.status).toBe(400);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		const unknown = (await b.authorize("http://localhost:9/client.json")).response;
		expect(unknown.status).toBe(400);
		expect(unknown.headers.get("location")).toBeNull();
		expect(h.upstream.requests.length).toBe(calls);
	}),
);

it(
	"keeps the newest 64 consents in a cookie under 4 KB",
	withHarness(async (h) => {
		h.upstream.profile.google = {
			sub: "1".repeat(21),
			email: `${"p".repeat(200)}@example.com`,
			email_verified: true,
		};
		const b = browser(h);
		const clients = Array.from({ length: 65 }, (_, index) => h.clients.board(`/c${index}/client.json`));
		const google = { provider: "google" };
		const [oldest = "", second = "", ...rest] = clients;
		const cookies = [(await b.signIn(oldest, google)).consent];
		for (const clientId of [second, ...rest]) {
			const asked = await b.authorize(clientId, google);
			await toConsent(asked.response);
			cookies.push(await b.decide(asked.response, "continue"));
		}
		const lines = cookies.flatMap((response) =>
			response.headers.getSetCookie().filter((line) => line.startsWith(`${sessionCookie("google")}=`)),
		);
		expect(lines).toHaveLength(65);
		expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(4096);
		await toConsent((await b.authorize(oldest, google)).response);
		toBoard((await b.authorize(second, google)).response);
		toBoard((await b.authorize(clients[64] ?? "", google)).response);
	}),
);

it(
	"signs out only from its own page, ending both providers' sessions",
	withHarness(async (h) => {
		const b = browser(h);
		const board = h.clients.board();
		await b.signIn(board);
		await b.signIn(board, { provider: "google" });
		// A Google sign-in leaves the GitHub session alone.
		toBoard((await b.authorize(board)).response);
		toBoard((await b.authorize(board, { provider: "google" })).response);

		const page = await b.visit("/signout");
		expect(page.status).toBe(200);
		expect(page.headers.getSetCookie()).toEqual([]);
		expect(page.headers.get("content-security-policy")).toContain("form-action 'self';");
		expect(page.headers.get("referrer-policy")).toBe("same-origin");
		expect(await page.text()).toContain('<form method="post" action="/signout">');

		const post = (origin?: string) =>
			b.visit("/signout", { method: "POST", headers: origin === undefined ? {} : { origin } });
		for (const refused of [await post(), await post("null"), await post("https://board.test")]) {
			expect(refused.status).toBe(403);
			expect(refused.headers.getSetCookie()).toEqual([]);
		}
		toBoard((await b.authorize(board)).response);

		const signedOut = await post(issuer);
		expect(signedOut.status).toBe(200);
		const expired = signedOut.headers.getSetCookie();
		for (const name of [sessionCookie("github"), sessionCookie("google"), "__Host-signin.tx"])
			expect(expired.find((line) => line.startsWith(`${name}=;`))).toMatch(
				/^[^;]+=; Max-Age=0; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/,
			);
		expect(b.jar.size).toBe(0);
		toProvider(h, (await b.authorize(board)).response);
		toProvider(h, (await b.authorize(board, { provider: "google" })).response, "google");
	}),
);
