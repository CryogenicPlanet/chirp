/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Effect, Layer, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { SignJWT, UnsecuredJWT } from "jose";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import type { RelyingParty } from "../../src/auth-origins.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import type { OidcConfig } from "../../src/oidc-client.ts";
import { authenticator } from "./authenticator.ts";
import { fakeIssuer, sign, signingKey, type FakeIssuer, type Grant } from "./oidc-issuer.ts";

const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const primary: RelyingParty = { rpId: "comms.test", expectedOrigin: "https://comms.test" };
const clientId = "https://comms.test/auth/oidc/client.json";
const octocat: Grant = { subject: "github:1", provider: "github", label: "octocat" };
const human: Grant = { subject: "google:108", provider: "google", label: "human@example.com" };
const issuer = await fakeIssuer();
const elsewhere = await fakeIssuer();

const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const dependencies = lockLayer.pipe(Layer.provideMerge(eventsLayer(Effect.void)));
	/** A boot process: rebuilding it keeps the database and drops every in-memory cache. */
	const build = (oidc: OidcConfig | null = { issuer: issuer.issuer }) =>
		Layer.build(authLayer({ ...primary, ...(oidc === null ? {} : { oidc }) }).pipe(Layer.provide(dependencies))).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
	const device = authenticator();
	const counter = { value: 0 };
	const proof = (started: { readonly id: string; readonly options: { readonly challenge: string } }) => ({
		id: started.id,
		response: device.assertion(started.options.challenge, ++counter.value),
	});
	const refused = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: string) =>
		Effect.gen(function* () {
			const result = yield* Effect.result(effect);
			assert.ok(Result.isFailure(result), `Expected ${expected}, but it succeeded`);
			const failure: unknown = result.failure;
			assert.ok(
				typeof failure === "object" && failure !== null && "code" in failure && failure.code === expected,
				`Expected ${expected}, got ${String(typeof failure === "object" && failure !== null && "code" in failure ? failure.code : failure)}`,
			);
		});
	const sessions = Effect.map(sql`SELECT id FROM sessions`, (rows) => rows.length);
	type Boot = Effect.Success<ReturnType<typeof build>>;
	type Callback = Parameters<Boot["finishOidc"]>[0];
	const setup = (auth: Boot) =>
		Effect.gen(function* () {
			const code = output.at(-1)?.split("code ")[1];
			assert.ok(code);
			const started = yield* auth.startSetup(code);
			yield* auth.finishSetup(started.id, device.registration(started.options.challenge));
		});
	const passkeySession = (auth: Boot) =>
		Effect.gen(function* () {
			const login = yield* auth.startLogin;
			return yield* auth.finishLogin(login.id, proof(login).response);
		});
	/** Start a round trip and let the issuer approve it, returning what the browser's callback would carry. */
	const begin = (
		auth: Boot,
		grant: Grant,
		options: {
			readonly intent?: "login" | "link";
			readonly session?: string;
			readonly next?: string;
			readonly party?: RelyingParty;
			readonly via?: FakeIssuer;
		} = {},
	) =>
		Effect.gen(function* () {
			const via = options.via ?? issuer;
			const started = yield* auth.startOidc(
				{
					intent: options.intent ?? "login",
					provider: grant.provider,
					...(options.next === undefined ? {} : { next: options.next }),
				},
				options.party ?? primary,
				options.session ?? null,
			);
			const issued = via.issue(started.authorizationUrl, grant);
			return {
				issued,
				callback: {
					state: issued.state,
					code: issued.code,
					iss: via.issuer,
					binding: started.binding,
					refused: false,
				},
			};
		});
	const signIn = (auth: Boot, grant: Grant) =>
		Effect.gen(function* () {
			const result = yield* auth.finishOidc((yield* begin(auth, grant)).callback);
			assert.equal(result._tag, "session");
			return result;
		});
	const pendingLink = (auth: Boot, session: string, grant: Grant, via: FakeIssuer = issuer) =>
		Effect.gen(function* () {
			const { callback } = yield* begin(auth, grant, { intent: "link", session, via });
			const result = yield* auth.finishOidc(callback);
			assert.equal(result._tag, "pending");
			const id = new URL(result.next, primary.expectedOrigin).searchParams.get("link");
			assert.ok(id);
			assert.equal(result.next, `/@rahul?link=${id}`);
			return id;
		});
	const confirm = (auth: Boot, session: string, id: string) =>
		Effect.gen(function* () {
			const started = yield* auth.startIdentityLinkAssertion({ id }, session);
			return yield* auth.linkIdentity({ id }, proof(started), session);
		});
	const unlink = (auth: Boot, session: string, id: string) =>
		Effect.gen(function* () {
			const started = yield* auth.startIdentityUnlinkAssertion({ id }, session);
			return yield* auth.unlinkIdentity({ id }, proof(started), session);
		});
	const identityOf = (auth: Boot, session: string, provider: "github" | "google") =>
		Effect.gen(function* () {
			const found = (yield* auth.listIdentities(session)).identities.find((item) => item.provider === provider);
			assert.ok(found);
			return found.id;
		});

	if (scenario === "refusals") {
		const auth = yield* build();
		yield* setup(auth);
		const owner = yield* passkeySession(auth);
		const linked = yield* confirm(auth, owner.id, yield* pendingLink(auth, owner.id, octocat));
		assert.deepEqual(
			{ provider: linked.provider, label: linked.label, issuer: linked.issuer, active: linked.active },
			{ provider: "github", label: "octocat", issuer: issuer.issuer, active: true },
		);
		// A linked identity opens an ordinary session for the requested same-origin page.
		const opened = yield* begin(auth, octocat, { next: "/t/design?x=1" });
		assert.equal(opened.issued.clientId, clientId);
		const session = yield* auth.finishOidc(opened.callback);
		assert.ok(session._tag === "session" && session.next === "/t/design?x=1");
		assert.ok((yield* auth.authenticateSession(session.session.token)).id);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${opened.callback.state}`).length, 0);
		assert.equal(
			(yield* sql`SELECT seq FROM events WHERE type='auth.oidc_login'`).length,
			1,
			"Sign-in is recorded as a boot event",
		);
		// Every refusal leaves no new session behind.
		const refuse = (
			grant: Grant,
			expected: string,
			change: (callback: Callback) => Callback = (value) => value,
			name: string = expected,
		) =>
			Effect.gen(function* () {
				const { callback } = yield* begin(auth, grant);
				const before = yield* sessions;
				yield* refused(auth.finishOidc(change(callback)), expected);
				assert.equal(yield* sessions, before, `${name} opened a session`);
				// Every refused callback naming a live state spends it.
				assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${callback.state}`).length, 0, name);
				return callback;
			});
		yield* refuse(octocat, "oidc_invalid", (callback) => ({ ...callback, binding: null }));
		yield* refuse(octocat, "oidc_invalid", (callback) => ({ ...callback, binding: "x".repeat(43) }));
		yield* refuse(octocat, "oidc_invalid", (callback) => ({ ...callback, iss: "https://auth.chirp.wiki" }));
		yield* refuse(octocat, "oidc_invalid", (callback) => ({ ...callback, code: undefined }));
		yield* refuse(octocat, "oidc_invalid", (callback) => ({ ...callback, refused: true }));
		// An unknown state, or a state that is not a sign-in's, is refused and leaves what it named alone.
		const named = yield* begin(auth, octocat);
		yield* refused(auth.finishOidc({ ...named.callback, state: "unknown-state" }), "oidc_invalid");
		const pendingRow = yield* pendingLink(auth, owner.id, human);
		yield* refused(auth.finishOidc({ ...named.callback, state: pendingRow }), "oidc_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${pendingRow}`).length, 1);
		// The takeover this closes: an attacker starts a sign-in and gets the owner to approve it. The code lands
		// in the owner's browser, which has no binding, and that refusal spends the state, so replaying the same
		// callback from the attacker's browser, which has the binding, fails.
		yield* refused(auth.finishOidc({ ...named.callback, binding: null }), "oidc_invalid");
		const replayBefore = yield* sessions;
		yield* refused(auth.finishOidc(named.callback), "oidc_invalid");
		assert.equal(yield* sessions, replayBefore);
		const expiring = yield* begin(auth, octocat);
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${expiring.callback.state}`;
		yield* refused(auth.finishOidc(expiring.callback), "oidc_invalid");
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${expiring.callback.state}`).length, 0);
		// Boot spends the state itself, even if an issuer would redeem a code twice.
		issuer.modes.reuse = true;
		const reused = yield* begin(auth, octocat);
		assert.equal((yield* auth.finishOidc(reused.callback))._tag, "session");
		yield* refused(auth.finishOidc(reused.callback), "oidc_invalid");
		issuer.modes.reuse = false;
		const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
		const forger = yield* Effect.promise(() => signingKey("k1"));
		const fetches = issuer.counts.jwks;
		for (const [label, grant] of [
			["bad signature", { ...octocat, mint: (payload) => sign(payload, forger) }],
			["alg none", { ...octocat, mint: (payload) => Promise.resolve(new UnsecuredJWT(payload).encode()) }],
			[
				"HS256",
				{
					...octocat,
					mint: (payload) =>
						new SignJWT(payload)
							.setProtectedHeader({ alg: "HS256", kid: "k1" })
							.sign(new TextEncoder().encode("a shared secret no public verifier holds")),
				},
			],
			["wrong iss", { ...octocat, claims: (payload) => ({ ...payload, iss: "https://evil.test" }) }],
			["wrong aud", { ...octocat, claims: (payload) => ({ ...payload, aud: "https://other.test/client.json" }) }],
			[
				"wrong azp",
				{
					...octocat,
					claims: (payload) => ({ ...payload, aud: [clientId, "https://other.test"], azp: "https://other.test" }),
				},
			],
			[
				"several audiences without azp",
				{
					...octocat,
					claims: ({ azp: _azp, ...payload }) => ({ ...payload, aud: [clientId, "https://other.test"] }),
				},
			],
			["expired", { ...octocat, claims: (payload) => ({ ...payload, exp: now - 120 }) }],
			["future iat", { ...octocat, claims: (payload) => ({ ...payload, iat: now + 600 }) }],
			["stale iat", { ...octocat, claims: (payload) => ({ ...payload, iat: now - 3600 }) }],
			["missing nonce", { ...octocat, claims: ({ nonce: _nonce, ...payload }) => payload }],
			["mismatched nonce", { ...octocat, claims: (payload) => ({ ...payload, nonce: "another-nonce" }) }],
			["unknown provider", { ...octocat, claims: (payload) => ({ ...payload, chirp_provider: "gitlab" }) }],
		] as const satisfies ReadonlyArray<readonly [string, Grant]>) {
			yield* refuse(grant, "oidc_invalid", undefined, label);
		}
		assert.equal(issuer.counts.jwks, fetches, "A known kid never refetches keys");
		// Clock skew up to 60 seconds is tolerated.
		assert.equal(
			(yield* signIn(auth, { ...octocat, claims: (payload) => ({ ...payload, iat: now + 30 }) }))._tag,
			"session",
		);
		// An unknown kid earns exactly one refetch: enough for a key rotated in since boot cached the set.
		const rotated = yield* Effect.promise(() => signingKey("k2"));
		const rotation = yield* begin(auth, { ...octocat, mint: (payload) => sign(payload, rotated) });
		issuer.publish(rotated.publicJwk);
		const before = issuer.counts.jwks;
		assert.equal((yield* auth.finishOidc(rotation.callback))._tag, "session");
		assert.equal(issuer.counts.jwks, before + 1);
		const never = yield* Effect.promise(() => signingKey("k3"));
		const unknown = issuer.counts.jwks;
		yield* refuse({ ...octocat, mint: (payload) => sign(payload, never) }, "oidc_invalid");
		assert.equal(issuer.counts.jwks, unknown + 1);
		// Identities match by issuer and subject only: the same label under another subject is a stranger.
		const stranger = yield* refuse(
			{ subject: "github:2", provider: "github", label: "octocat" },
			"identity_not_linked",
		);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${stranger.state}`).length, 0);
		// The token endpoint failing, timing out or answering garbage is the service being unavailable; a refused
		// code is an invalid sign-in.
		for (const [mode, expected] of [
			["error", "oidc_unavailable"],
			["html", "oidc_unavailable"],
			["refuse", "oidc_invalid"],
		] as const) {
			issuer.modes.token = mode;
			yield* refuse(octocat, expected);
		}
		issuer.modes.token = "ok";
		// Boot always names a provider the issuer accepts; a request without one comes back as invalid_request with
		// no code, and that callback spends the state like any other refusal.
		const declined = yield* auth.startOidc({ intent: "login", provider: "github" }, primary, null);
		const withoutProvider = new URL(declined.authorizationUrl);
		withoutProvider.searchParams.delete("provider");
		const answer = issuer.issue(withoutProvider.href, octocat);
		assert.equal(answer.code, undefined);
		assert.equal(new URL(answer.callback).searchParams.get("error"), "invalid_request");
		yield* refused(
			auth.finishOidc({
				state: answer.state,
				code: undefined,
				iss: issuer.issuer,
				binding: declined.binding,
				refused: true,
			}),
			"oidc_invalid",
		);
		assert.equal((yield* sql`SELECT id FROM auth_challenges WHERE id=${answer.state}`).length, 0);
		// A code the issuer bound to another redirect is refused by its token endpoint.
		const misdirected = yield* auth.startOidc({ intent: "login", provider: "github" }, primary, null);
		const elsewhereUrl = new URL(misdirected.authorizationUrl);
		elsewhereUrl.searchParams.set("redirect_uri", "https://x.test/auth/oidc/callback");
		const foreign = issuer.issue(elsewhereUrl.href, octocat);
		yield* refused(
			auth.finishOidc({
				state: foreign.state,
				code: foreign.code,
				iss: issuer.issuer,
				binding: misdirected.binding,
				refused: false,
			}),
			"oidc_invalid",
		);
	} else if (scenario === "stall") {
		const auth = yield* build();
		yield* setup(auth);
		const owner = yield* passkeySession(auth);
		yield* confirm(auth, owner.id, yield* pendingLink(auth, owner.id, octocat));
		const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const started = yield* Clock.currentTimeMillis;
				const result = yield* Effect.result(effect);
				return { result, started, finished: yield* Clock.currentTimeMillis };
			});
		const passkeyLogin = (instance: Boot) =>
			timed(Effect.sleep("200 millis").pipe(Effect.andThen(passkeySession(instance))));
		// A token endpoint that never answers holds the callback for its 5-second limit and no lock.
		issuer.modes.token = "stall";
		const { callback } = yield* begin(auth, octocat);
		const [stalled, login] = yield* Effect.all([timed(auth.finishOidc(callback)), passkeyLogin(auth)], {
			concurrency: "unbounded",
		});
		issuer.release();
		issuer.modes.token = "ok";
		assert.ok(Result.isSuccess(login.result));
		assert.ok(login.finished - login.started < 2000, "Passkey sign-in waited on the issuer");
		assert.ok(login.finished < stalled.finished - 2000);
		assert.ok(stalled.finished - stalled.started >= 4500 && stalled.finished - stalled.started < 9000);
		yield* refused(Effect.fromResult(stalled.result), "oidc_unavailable");
		// Discovery that never answers holds only that start, on a process with nothing cached.
		const fresh = yield* build();
		issuer.modes.discovery = "stall";
		const [starting, during] = yield* Effect.all(
			[timed(fresh.startOidc({ intent: "login", provider: "github" }, primary, null)), passkeyLogin(fresh)],
			{ concurrency: "unbounded" },
		);
		issuer.release();
		issuer.modes.discovery = "ok";
		assert.ok(Result.isSuccess(during.result));
		assert.ok(during.finished - during.started < 2000, "Passkey sign-in waited on discovery");
		assert.ok(during.finished < starting.finished - 2000);
		yield* refused(Effect.fromResult(starting.result), "oidc_unavailable");
		// The service recovering needs nothing but a new attempt.
		assert.equal((yield* signIn(fresh, octocat))._tag, "session");
	} else if (scenario === "discovery") {
		const auth = yield* build();
		yield* setup(auth);
		const owner = yield* passkeySession(auth);
		yield* confirm(auth, owner.id, yield* pendingLink(auth, owner.id, octocat));
		// A discovery document naming another issuer, an endpoint off the issuer's origin or with credentials in it,
		// a redirect, more than 64 KiB, or no JSON at all is the service being unavailable. Each is tried by a process
		// with nothing cached, and passkey sign-in carries on.
		for (const mode of ["mismatch", "offorigin", "userinfo", "redirect", "large", "html"] as const) {
			issuer.modes.discovery = mode;
			const fresh = yield* build();
			yield* refused(fresh.startOidc({ intent: "login", provider: "github" }, primary, null), "oidc_unavailable");
			assert.ok((yield* passkeySession(fresh)).id, mode);
		}
		issuer.modes.discovery = "ok";
		assert.equal(issuer.counts.moved, 0, "A discovery redirect is never followed");
		// Keys that are too large or not JSON fail the same way, at the callback that needs them.
		for (const mode of ["large", "html"] as const) {
			const fresh = yield* build();
			const { callback } = yield* begin(fresh, octocat);
			issuer.modes.jwks = mode;
			yield* refused(fresh.finishOidc(callback), "oidc_unavailable");
			issuer.modes.jwks = "ok";
			assert.ok((yield* passkeySession(fresh)).id, mode);
		}
		// A sound service needs nothing but a new attempt.
		assert.equal((yield* signIn(yield* build(), octocat))._tag, "session");
	} else if (scenario === "assertions") {
		const auth = yield* build();
		// Before the first passkey nothing can be linked, so no sign-in starts and no identity action can be proven.
		yield* refused(auth.startOidc({ intent: "login", provider: "github" }, primary, null), "identity_not_linked");
		yield* refused(auth.startIdentityLinkAssertion({ id: "a".repeat(43) }, "session"), "setup_required");
		yield* setup(auth);
		const first = yield* passkeySession(auth);
		const second = yield* passkeySession(auth);
		yield* refused(auth.startIdentityLinkAssertion({ id: "short" }, first.id), "invalid_request");
		yield* refused(auth.startIdentityUnlinkAssertion({ id: "A".repeat(64) }, first.id), "invalid_request");
		const pending = yield* pendingLink(auth, first.id, octocat);
		const listed = yield* auth.listIdentities(first.id);
		assert.deepEqual(
			listed.pending.map((row) => ({ id: row.id, label: row.label })),
			[{ id: pending, label: "octocat" }],
		);
		assert.equal((yield* auth.listIdentities(second.id)).pending.length, 0);
		// Another session cannot confirm the pending link, even with its own valid proof.
		const fromSecond = yield* auth.startIdentityLinkAssertion({ id: pending }, second.id);
		yield* refused(auth.linkIdentity({ id: pending }, proof(fromSecond), second.id), "identity_not_found");
		// A proof bound to one session or one pending link proves nothing else.
		const forFirst = yield* auth.startIdentityLinkAssertion({ id: pending }, first.id);
		yield* refused(auth.linkIdentity({ id: pending }, proof(forFirst), second.id), "challenge_invalid");
		const other = yield* pendingLink(auth, first.id, human);
		const waiting = yield* auth.listIdentities(first.id);
		assert.equal(waiting.pending.length, 2);
		assert.ok(waiting.pending.some((row) => row.id === pending && row.label === "octocat"));
		assert.ok(waiting.pending.some((row) => row.id === other && row.label === "human@example.com"));
		const forOther = yield* auth.startIdentityLinkAssertion({ id: other }, first.id);
		yield* refused(auth.linkIdentity({ id: pending }, proof(forOther), first.id), "challenge_invalid");
		// The right session and proof link it once, and the proof does not replay.
		const right = proof(yield* auth.startIdentityLinkAssertion({ id: pending }, first.id));
		yield* auth.linkIdentity({ id: pending }, right, first.id);
		yield* refused(auth.linkIdentity({ id: pending }, right, first.id), "challenge_invalid");
		// Linking the same account again is refused at the callback; a second pending link made before the first
		// was confirmed is refused at confirmation.
		const again = yield* begin(auth, octocat, { intent: "link", session: first.id });
		yield* refused(auth.finishOidc(again.callback), "identity_exists");
		const twin = yield* pendingLink(auth, first.id, human);
		yield* confirm(auth, first.id, other);
		yield* refused(confirm(auth, first.id, twin), "identity_exists");
		// A link started by a session that ended before the callback does not complete.
		const ending = yield* begin(
			auth,
			{ subject: "github:7", provider: "github" },
			{ intent: "link", session: second.id },
		);
		yield* auth.logout(second.token);
		yield* refused(auth.finishOidc(ending.callback), "session_invalid");
		yield* refused(auth.startOidc({ intent: "link", provider: "github" }, primary, second.id), "session_invalid");
		// Unlinking needs a proof for that identity, and ends every session but the one that proved it.
		const third = yield* passkeySession(auth);
		const github = yield* identityOf(auth, first.id, "github");
		const google = yield* identityOf(auth, first.id, "google");
		const wrong = yield* auth.startIdentityUnlinkAssertion({ id: google }, first.id);
		yield* refused(auth.unlinkIdentity({ id: github }, proof(wrong), first.id), "challenge_invalid");
		yield* unlink(auth, first.id, github);
		yield* refused(auth.authenticateSession(third.token), "session_invalid");
		assert.ok((yield* auth.authenticateSession(first.token)).id);
		yield* refused(unlink(auth, first.id, github), "identity_not_found");
		assert.deepEqual(yield* auth.linkedProviders, ["google"]);
		// A sign-in for a provider with nothing linked writes no row and asks the issuer nothing, even with nothing
		// cached, so starting without a credential costs the board one settings read.
		const cold = yield* build();
		const rows = (yield* sql`SELECT id FROM auth_challenges`).length;
		const asked = { ...issuer.counts };
		yield* refused(cold.startOidc({ intent: "login", provider: "github" }, primary, null), "identity_not_linked");
		assert.equal((yield* sql`SELECT id FROM auth_challenges`).length, rows);
		assert.deepEqual(issuer.counts, asked);
		// The board's client document names a redirect for every allowed origin.
		yield* sql`INSERT INTO auth_origins (origin, rp_id, created_at) VALUES ('https://added.test', 'added.test', 0)`;
		assert.deepEqual(yield* auth.oidcClientDocument, {
			client_id: clientId,
			client_name: "comms.test",
			redirect_uris: ["https://comms.test/auth/oidc/callback", "https://added.test/auth/oidc/callback"],
			grant_types: ["authorization_code"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
		// After verification, the state's origin must still be allowed and a passkey must still exist.
		const added = yield* begin(auth, human, { party: { rpId: "added.test", expectedOrigin: "https://added.test" } });
		assert.ok(added.issued.callback.startsWith("https://added.test/auth/oidc/callback?"));
		yield* sql`DELETE FROM auth_origins`;
		yield* refused(auth.finishOidc(added.callback), "origin_invalid");
		// While no stored passkey can sign in, a linked account cannot either: it is never the way back in.
		const stranding = yield* begin(auth, human);
		yield* sql`UPDATE passkeys SET rp_id='elsewhere.test'`;
		yield* refused(auth.startOidc({ intent: "login", provider: "google" }, primary, null), "passkey_origin_mismatch");
		yield* refused(auth.finishOidc(stranding.callback), "passkey_origin_mismatch");
		yield* sql`UPDATE passkeys SET rp_id='comms.test'`;
		// Starting needs no credential, so live round trips are capped; passkey sign-in is untouched by the flood.
		for (let index = 0; index < 256; index++)
			yield* sql`INSERT INTO auth_challenges (id, challenge, ceremony, setup_generation, expires_at)
				VALUES (${`flood-${index}`}, '{}', 'oidc.login', NULL, ${Number.MAX_SAFE_INTEGER})`;
		yield* refused(auth.startOidc({ intent: "login", provider: "google" }, primary, null), "oidc_unavailable");
		assert.ok((yield* passkeySession(auth)).id);
		yield* sql`DELETE FROM auth_challenges WHERE id LIKE 'flood-%'`;
		const late = yield* begin(auth, human);
		yield* sql`DELETE FROM passkeys`;
		yield* refused(auth.finishOidc(late.callback), "setup_required");
	} else if (scenario === "concurrency") {
		const auth = yield* build();
		yield* setup(auth);
		const owner = yield* passkeySession(auth);
		yield* confirm(auth, owner.id, yield* pendingLink(auth, owner.id, octocat));
		// Two callbacks carrying one state open exactly one session, even if the issuer redeemed the code twice.
		issuer.modes.reuse = true;
		const duplicated = yield* begin(auth, octocat);
		const before = yield* sessions;
		const callbacks = yield* Effect.forEach(
			[duplicated.callback, duplicated.callback],
			(callback) => Effect.result(auth.finishOidc(callback)),
			{ concurrency: "unbounded" },
		);
		assert.equal(callbacks.filter(Result.isSuccess).length, 1);
		assert.equal(yield* sessions, before + 1);
		// The same across two boot instances, which share no mutex: the database row is taken once.
		const other = yield* build();
		const across = yield* begin(auth, octocat);
		const beforeAcross = yield* sessions;
		const raced = yield* Effect.forEach(
			[auth, other],
			(instance) => Effect.result(instance.finishOidc(across.callback)),
			{ concurrency: "unbounded" },
		);
		issuer.modes.reuse = false;
		assert.equal(raced.filter(Result.isSuccess).length, 1);
		assert.equal(yield* sessions, beforeAcross + 1);
		// The real issuer redeems a code once. Claiming the state first keeps the winner from being spent by the
		// loser that got invalid_grant.
		const once = yield* begin(auth, octocat);
		const beforeOnce = yield* sessions;
		const singleUse = yield* Effect.forEach(
			[once.callback, once.callback],
			(callback) => Effect.result(auth.finishOidc(callback)),
			{ concurrency: "unbounded" },
		);
		assert.equal(singleUse.filter(Result.isSuccess).length, 1);
		assert.equal(yield* sessions, beforeOnce + 1);
		// Two confirmations of one pending link store one identity.
		const pending = yield* pendingLink(auth, owner.id, human);
		const proofs = [
			proof(yield* auth.startIdentityLinkAssertion({ id: pending }, owner.id)),
			proof(yield* auth.startIdentityLinkAssertion({ id: pending }, owner.id)),
		];
		const confirmations = yield* Effect.forEach(
			proofs,
			(value) => Effect.result(auth.linkIdentity({ id: pending }, value, owner.id)),
			{ concurrency: "unbounded" },
		);
		assert.equal(confirmations.filter(Result.isSuccess).length, 1);
		assert.equal((yield* auth.listIdentities(owner.id)).identities.length, 2);
		// A sign-in whose callback finishes after an unlink commits is refused.
		const google = yield* identityOf(auth, owner.id, "google");
		const waiting = yield* begin(auth, human);
		yield* unlink(auth, owner.id, google);
		yield* refused(auth.finishOidc(waiting.callback), "identity_not_linked");
		// Racing them, whichever commits first, leaves no session opened by the unlinked identity.
		const github = yield* identityOf(auth, owner.id, "github");
		const racing = yield* begin(auth, octocat);
		const removal = proof(yield* auth.startIdentityUnlinkAssertion({ id: github }, owner.id));
		const [login] = yield* Effect.all(
			[Effect.result(auth.finishOidc(racing.callback)), auth.unlinkIdentity({ id: github }, removal, owner.id)],
			{ concurrency: "unbounded" },
		);
		if (Result.isSuccess(login) && login.success._tag === "session")
			yield* refused(auth.authenticateSession(login.success.session.token), "session_invalid");
		else yield* refused(Effect.fromResult(login), "identity_not_linked");
		assert.ok((yield* auth.authenticateSession(owner.token)).id);
	} else if (scenario === "restart") {
		const first = yield* build();
		yield* setup(first);
		const owner = yield* passkeySession(first);
		yield* confirm(first, owner.id, yield* pendingLink(first, owner.id, octocat));
		// A sign-in started before a restart finishes after it, and a link survives it.
		const started = yield* begin(first, octocat);
		const second = yield* build();
		assert.equal((yield* second.finishOidc(started.callback))._tag, "session");
		const pending = yield* pendingLink(second, owner.id, human);
		const third = yield* build();
		yield* confirm(third, owner.id, pending);
		assert.deepEqual(yield* third.linkedProviders, ["github", "google"]);
		// State that expired across a restart fails cleanly.
		const stale = yield* begin(third, octocat);
		yield* sql`UPDATE auth_challenges SET expires_at=0 WHERE id=${stale.callback.state}`;
		yield* refused((yield* build()).finishOidc(stale.callback), "oidc_invalid");
		const orphan = yield* pendingLink(third, owner.id, { subject: "github:9", provider: "github" });
		// Changing OIDC_ISSUER orphans every link: still listed and removable, never a sign-in.
		const moved = yield* build({ issuer: elsewhere.issuer });
		assert.deepEqual(yield* moved.linkedProviders, []);
		const listed = yield* moved.listIdentities(owner.id);
		assert.deepEqual(
			listed.identities.map((identity) => [identity.provider, identity.issuer, identity.active]),
			[
				["github", issuer.issuer, false],
				["google", issuer.issuer, false],
			],
		);
		yield* refused(moved.startOidc({ intent: "login", provider: "github" }, primary, null), "identity_not_linked");
		yield* refused(moved.finishOidc(stale.callback), "oidc_invalid");
		yield* refused(confirm(moved, owner.id, orphan), "oidc_invalid");
		// A token from the new issuer for a subject linked under the old one gets all the way to the callback and is
		// refused there, because identities match by issuer and subject. Another GitHub account linked under the new
		// issuer is what lets a GitHub sign-in start at all.
		const newcomer: Grant = { subject: "github:42", provider: "github", label: "newcomer" };
		yield* confirm(moved, owner.id, yield* pendingLink(moved, owner.id, newcomer, elsewhere));
		const foreign = yield* begin(moved, octocat, { via: elsewhere });
		yield* refused(moved.finishOidc(foreign.callback), "identity_not_linked");
		// The account linked under the new issuer does sign in through it.
		assert.equal(
			(yield* moved.finishOidc((yield* begin(moved, newcomer, { via: elsewhere })).callback))._tag,
			"session",
		);
		const github = listed.identities.find((identity) => identity.provider === "github");
		assert.ok(github);
		yield* unlink(moved, owner.id, github.id);
		assert.equal((yield* moved.listIdentities(owner.id)).identities.length, 2);
		// With OIDC off nothing starts or finishes, there is no client document, and links stay removable.
		const off = yield* build(null);
		yield* refused(off.startOidc({ intent: "login", provider: "github" }, primary, null), "oidc_disabled");
		yield* refused(off.finishOidc(started.callback), "oidc_disabled");
		assert.equal(yield* off.oidcClientDocument, null);
		const offList = yield* off.listIdentities(owner.id);
		assert.deepEqual(offList.providers, []);
		assert.equal(offList.identities.length, 2);
		assert.deepEqual(yield* off.linkedProviders, []);
	} else throw new Error(`Unknown scenario ${scenario}`);
});

try {
	await Effect.runPromise(
		run.pipe(
			Effect.scoped,
			Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunServices.layer, FetchHttpClient.layer)),
		),
	);
} finally {
	await Promise.all([issuer.close(), elsewhere.close()]);
}
await Effect.runPromise(Console.log("identity links scenario passed"));
