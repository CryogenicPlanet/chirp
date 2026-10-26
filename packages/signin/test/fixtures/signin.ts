import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { BunCrypto } from "@effect/platform-bun";
import { Clock, Duration, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { exportJWK, generateKeyPair } from "jose";
import * as ClientMetadata from "../../src/client-metadata.ts";
import * as Issuer from "../../src/issuer.ts";
import { routes } from "../../src/routes.ts";
import * as Settings from "../../src/settings.ts";
import * as Upstream from "../../src/upstream.ts";

export const issuer = "https://auth.test";
export const boardRedirect = "https://board.test/auth/oidc/callback";
export const cookieName = "__Host-signin.tx";
export const github = { clientId: "gh-client", clientSecret: "gh-secret" };
export const google = { clientId: "google-client", clientSecret: "google-secret" };

export const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
export const verifier = () => randomBytes(32).toString("base64url");

export const rawSettings = async (): Promise<Settings.RawSettings> => {
	const { privateKey } = await generateKeyPair("ES256", { extractable: true });
	return {
		issuer,
		signingKey: Redacted.make(JSON.stringify({ ...(await exportJWK(privateKey)), kid: "test-key" })),
		sealKey: Redacted.make(randomBytes(32).toString("hex")),
		github: { clientId: github.clientId, clientSecret: Redacted.make(github.clientSecret) },
		google: { clientId: google.clientId, clientSecret: Redacted.make(google.clientSecret) },
	};
};

/** A loopback web server for fakes. Vitest runs under Node, so this adapts node:http to fetch-style handlers. */
export const serve = async (host: string, handler: (request: Request) => Response | Promise<Response>) => {
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Array<Buffer> = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers))
			for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
		const method = incoming.method ?? "GET";
		const response = await handler(
			new Request(`http://${incoming.headers.host}${incoming.url}`, {
				method,
				headers,
				...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, host, resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
	const { port } = address;
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
};

type Pending = { readonly challenge: string; readonly redirectUri: string; readonly clientId: string };
export type GoogleProfile = { sub: string; email?: string; email_verified?: unknown };

/**
 * GitHub and Google as this service uses them: authorize redirects back with a code, token checks the client
 * secret, redirect_uri and PKCE verifier, and the user endpoints need the bearer token.
 */
export const fakeUpstream = async () => {
	const pending = new Map<string, Pending>();
	const profile: { github: { id: number; login: string }; google: GoogleProfile; refuseToken: boolean } = {
		github: { id: 4242, login: "octocat" },
		google: { sub: "1098765", email: "person@example.com", email_verified: true },
		refuseToken: false,
	};
	const requests: Array<{ path: string; params: URLSearchParams; headers: Headers }> = [];
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	const server = await serve("127.0.0.1", async (request) => {
		const url = new URL(request.url);
		const params = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
		requests.push({ path: url.pathname, params, headers: request.headers });
		const [, provider, step] = url.pathname.split("/");
		if (provider !== "github" && provider !== "google") return json({ error: "not_found" }, 404);
		const client = provider === "github" ? github : google;
		if (step === "authorize") {
			const code = randomBytes(8).toString("hex");
			pending.set(code, {
				challenge: params.get("code_challenge") ?? "",
				redirectUri: params.get("redirect_uri") ?? "",
				clientId: params.get("client_id") ?? "",
			});
			const back = new URL(params.get("redirect_uri") ?? "");
			back.searchParams.set("code", code);
			back.searchParams.set("state", params.get("state") ?? "");
			return new Response(null, { status: 302, headers: { location: back.href } });
		}
		if (step === "token") {
			const code = params.get("code") ?? "";
			const grant = pending.get(code);
			pending.delete(code);
			const valid =
				!profile.refuseToken &&
				grant !== undefined &&
				params.get("client_id") === client.clientId &&
				grant.clientId === client.clientId &&
				params.get("client_secret") === client.clientSecret &&
				params.get("redirect_uri") === grant.redirectUri &&
				s256(params.get("code_verifier") ?? "") === grant.challenge &&
				(provider === "github" || params.get("grant_type") === "authorization_code");
			// GitHub reports a refused exchange as 200 with an error body.
			if (!valid)
				return provider === "github" ? json({ error: "bad_verification_code" }) : json({ error: "invalid_grant" }, 400);
			return json({ access_token: `${provider}-token-${code}`, token_type: "bearer", scope: "" });
		}
		if (step === "user" || step === "userinfo") {
			const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
			if (!token.startsWith(`${provider}-token-`)) return json({ message: "Bad credentials" }, 401);
			if (provider === "github") {
				if (!request.headers.get("user-agent")) return json({ message: "User-Agent required" }, 403);
				return json({ ...profile.github, name: "The Octocat", email: "octocat@example.com" });
			}
			return json(profile.google);
		}
		return json({ error: "not_found" }, 404);
	});
	const base = `http://127.0.0.1:${server.port}`;
	const endpoints: Upstream.Endpoints = {
		github: { authorize: `${base}/github/authorize`, token: `${base}/github/token`, user: `${base}/github/user` },
		google: { authorize: `${base}/google/authorize`, token: `${base}/google/token`, user: `${base}/google/userinfo` },
	};
	return { endpoints, profile, requests, close: server.close };
};

/** Serves client metadata documents from http://localhost, reachable only through the test-only loopback layer. */
export const documentServer = async () => {
	const documents = new Map<string, (request: Request) => Response | Promise<Response>>();
	// Listen where the service will connect: the first answer for localhost.
	const { address } = await lookup("localhost", { verbatim: true });
	const server = await serve(
		address,
		(request) => documents.get(new URL(request.url).pathname)?.(request) ?? new Response("missing", { status: 404 }),
	);
	const url = (path: string) => `http://localhost:${server.port}${path}`;
	/** A board client document as boot serves it. */
	const board = (path = "/auth/oidc/client.json", overrides: Record<string, unknown> = {}) => {
		const clientId = url(path);
		documents.set(path, () =>
			Response.json({
				client_id: clientId,
				client_name: "board.test",
				redirect_uris: [boardRedirect],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				...overrides,
			}),
		);
		return clientId;
	};
	return { documents, url, board, close: server.close };
};

/** The wall clock the service reads, moved forward only by `advance`. Sleeps and monotonic time stay real. */
const shiftedClock = () => {
	const real = Clock.Clock.defaultValue();
	const shift = { millis: 0 };
	const millis = () => real.currentTimeMillisUnsafe() + shift.millis;
	const nanos = () => real.currentTimeNanosUnsafe() + BigInt(shift.millis) * 1_000_000n;
	const clock: Clock.Clock = {
		currentTimeMillisUnsafe: millis,
		currentTimeMillis: Effect.sync(millis),
		currentTimeNanosUnsafe: nanos,
		currentTimeNanos: Effect.sync(nanos),
		monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
		monotonicTimeNanos: real.monotonicTimeNanos,
		sleep: (duration) => real.sleep(duration),
	};
	const advance = (duration: Duration.Duration) => {
		shift.millis += Duration.toMillis(duration);
	};
	return { clock, advance };
};

/** The whole service in process, with fake upstreams and loopback client documents. */
export const harness = async () => {
	const upstream = await fakeUpstream();
	const clients = await documentServer();
	const raw = await rawSettings();
	const time = shiftedClock();
	const services = Layer.mergeAll(
		Issuer.layer,
		ClientMetadata.loopbackLayerForTests,
		Upstream.layer(upstream.endpoints),
	).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Settings.fromRaw(raw),
				FetchHttpClient.layer,
				BunCrypto.layer,
				Layer.succeed(Clock.Clock, time.clock),
			),
		),
	);
	const app = HttpRouter.toWebHandler(routes.pipe(Layer.provideMerge(services)), { disableLogger: true });
	const request = (path: string, init?: RequestInit) => app.handler(new Request(`${issuer}${path}`, init));
	return {
		raw,
		upstream,
		clients,
		request,
		advance: time.advance,
		close: async () => {
			await app.dispose();
			await upstream.close();
			await clients.close();
		},
	};
};
export type Harness = Awaited<ReturnType<typeof harness>>;

/** Each test owns its harness: created before the body and closed after it, pass or fail. */
export const withHarness =
	<A extends ReadonlyArray<unknown>>(body: (h: Harness, ...args: A) => Promise<void>) =>
	async (...args: A) => {
		const h = await harness();
		try {
			await body(h, ...args);
		} finally {
			await h.close();
		}
	};

export const transactionCookie = (response: Response) => {
	const header = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
	return header?.slice(cookieName.length + 1).split(";")[0];
};

export const location = (response: Response) => new URL(response.headers.get("location") ?? "about:blank");

/** Board-side parameters for /authorize; `null` drops a parameter. */
export const authorizeQuery = (clientId: string, challenge: string, overrides: Record<string, string | null> = {}) => {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries({
		response_type: "code",
		client_id: clientId,
		redirect_uri: boardRedirect,
		state: "board-state",
		nonce: "board-nonce",
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "openid",
		provider: "github",
		...overrides,
	}))
		if (value !== null) params.set(name, value);
	return `/authorize?${params}`;
};

/** Authorize, then let the fake upstream sign in and return the browser to our callback with the cookie. */
export const throughUpstream = async (h: Harness, provider: "github" | "google" = "github") => {
	const boardVerifier = verifier();
	const clientId = h.clients.board();
	const authorized = await h.request(authorizeQuery(clientId, s256(boardVerifier), { provider }));
	const cookie = transactionCookie(authorized);
	const upstream = await fetch(location(authorized), { redirect: "manual" });
	const back = location(upstream);
	const callback = await h.request(`${back.pathname}${back.search}`, {
		headers: { cookie: `${cookieName}=${cookie}` },
	});
	return { clientId, boardVerifier, authorized, callback, cookie: transactionCookie(callback) };
};

export const csrfOf = async (page: Response) => /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";

export const postConsent = (
	h: Harness,
	cookie: string | undefined,
	form: Record<string, string>,
	origin: string | null = issuer,
) =>
	h.request("/consent", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...(cookie === undefined ? {} : { cookie: `${cookieName}=${cookie}` }),
			...(origin === null ? {} : { origin }),
		},
		body: new URLSearchParams(form),
	});

/** A full sign-in up to the board's callback: returns the code and the verifier the board would hold. */
export const signIn = async (h: Harness, provider: "github" | "google" = "github") => {
	const through = await throughUpstream(h, provider);
	const consent = await postConsent(h, through.cookie, { csrf: await csrfOf(through.callback), decision: "continue" });
	const back = location(consent);
	return { ...through, consent, back, code: back.searchParams.get("code") ?? "" };
};

export const token = (h: Harness, params: Record<string, string>, contentType = "application/x-www-form-urlencoded") =>
	h.request("/token", { method: "POST", headers: { "content-type": contentType }, body: new URLSearchParams(params) });
