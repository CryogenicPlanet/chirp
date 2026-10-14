import { on } from "@comms/storage/dialect";
import { lockBootWrite } from "./boot-write-lock.ts";
// Effect Crypto has no constant-time comparison primitive.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { timingSafeEqual } from "node:crypto";
import { authSecrets, captureRefusal, committed, refuse } from "./auth-primitives.ts";
import { Clock, Crypto, Effect, Option, Schema, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError, type AuthConfig } from "./auth.ts";
import { allowedParties, type RelyingParty } from "./auth-origins.ts";
import { decodeRows } from "./decode-rows.ts";
import { approvalReturn } from "./enrollment-page.ts";
import type { AssertionProof } from "./enrollment.ts";
import { Events } from "./events.ts";
import { humanAgent } from "./human-agent.ts";
import { makeOidcClient } from "./oidc-client.ts";
import {
	canonicalIdentityLink,
	canonicalIdentityUnlink,
	identityId,
	identityPrefix,
	LinkedIdentity,
	oidcProviders,
	OidcState,
	PendingLink,
	validIdentityId,
	validPendingId,
	type IdentityAction,
	type OidcStart,
} from "./oidc-schema.ts";

/** One sign-in round trip through the issuer, or one pending link, lives ten minutes. */
export const oidcLifetimeMs = 10 * 60_000;
/** Starting needs no credential, so live round trips are capped: a flood refuses new ones instead of growing the
 * table every passkey ceremony scans under the mutex. */
const liveRoundTrips = 256;
export const oidcClientPath = "/auth/oidc/client.json";
export const oidcCallbackPath = "/auth/oidc/callback";

const challengeRow = Schema.Struct({
	challenge: Schema.String,
	setup_generation: Schema.NullOr(Schema.String),
	expires_at: Schema.Finite,
});
const stateRow = Schema.Struct({ ceremony: Schema.String, ...challengeRow.fields });
const settingRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const decodeIdentity = Schema.decodeOption(Schema.fromJsonString(LinkedIdentity));
const same = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** GitHub and Google identities linked through the configured issuer. They only ever open an ordinary session: linking
 * and unlinking need a fresh passkey assertion, and nothing here can add a passkey, reopen setup or replace recovery. */
export const makeIdentityLinks = <E, R, S extends { readonly id: string }, SE, SR, OE, OR>(
	config: AuthConfig,
	verify: (
		action: "identity.link" | "identity.unlink",
		binding: string,
		proof: AssertionProof,
	) => Effect.Effect<void, E, R>,
	newSession: (origin: string) => Effect.Effect<S, SE, SR>,
	// While no stored passkey can sign in, neither can a linked account: it must never become the way back in.
	stranded: Effect.Effect<boolean, OE, OR>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const { hash, random } = authSecrets(crypto);
		const issuer = config.oidc?.issuer ?? null;
		const oidc =
			config.oidc === undefined
				? null
				: yield* makeOidcClient(config.oidc, `${config.expectedOrigin}${oidcClientPath}`);
		const enabled = oidc === null ? refuse("oidc_disabled") : Effect.succeed(oidc);
		const event = (type: string, payload: Schema.Json, instance: string | null = null) =>
			Effect.gen(function* () {
				yield* events.writeBoot({
					at: yield* Clock.currentTimeMillis,
					type,
					level: "info",
					actor: humanAgent,
					instance,
					generation: 0,
					request_id: null,
					topic: null,
					message_id: null,
					payload,
				});
			});
		const noPasskeys = Effect.map(sql`SELECT id FROM passkeys LIMIT 1`, (rows) => rows.length === 0);
		const passkeysUsable = Effect.gen(function* () {
			if (yield* noPasskeys) return yield* refuse("setup_required");
			if (yield* stranded) return yield* refuse("passkey_origin_mismatch");
		});
		const liveSession = (sessionId: string) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				if (!(yield* sql`SELECT id FROM sessions WHERE id=${sessionId} AND expires_at>${now}`).length)
					return yield* refuse("session_invalid");
			});
		const stored = (id: string) =>
			Effect.map(
				sql`SELECT value FROM settings WHERE ${sql("key")}=${`${identityPrefix}${id}`}`.pipe(
					decodeRows(Schema.Struct({ value: Schema.String })),
				),
				(rows) => rows[0],
			);
		const linked =
			sql`SELECT ${sql("key")}, value FROM settings WHERE ${sql("key")} LIKE ${`${identityPrefix}%`} ORDER BY ${sql("key")}`.pipe(
				decodeRows(settingRow),
				Effect.map((rows) =>
					rows.flatMap((row) => {
						const id = row.key.slice(identityPrefix.length);
						const identity = decodeIdentity(row.value);
						return validIdentityId(id) && Option.isSome(identity) ? [{ id, ...identity.value }] : [];
					}),
				),
			);
		/** Delete one ceremony row and return it, or nothing when another request already took it. */
		const take = (id: string, ceremony: string, session: string | null) => {
			const row =
				session === null
					? sql`id=${id} AND ceremony=${ceremony}`
					: sql`id=${id} AND ceremony=${ceremony} AND setup_generation=${session}`;
			return on(sql, {
				sqlite: () => sql`DELETE FROM auth_challenges WHERE ${row} RETURNING challenge, setup_generation, expires_at`,
				pg: () => sql`DELETE FROM auth_challenges WHERE ${row} RETURNING challenge, setup_generation, expires_at`,
				mysql: () =>
					Effect.gen(function* () {
						const found =
							yield* sql`SELECT challenge, setup_generation, expires_at FROM auth_challenges WHERE ${row} FOR UPDATE`;
						if (found.length) yield* sql`DELETE FROM auth_challenges WHERE ${row}`;
						return found;
					}),
			}).pipe(
				decodeRows(challengeRow),
				Effect.map((rows) => (rows.length === 1 ? rows[0] : undefined)),
			);
		};

		/** The board's own client metadata document, or null when OIDC is off. */
		const oidcClientDocument = Effect.gen(function* () {
			if (config.oidc === undefined) return null;
			return {
				client_id: `${config.expectedOrigin}${oidcClientPath}`,
				client_name: new URL(config.expectedOrigin).host,
				redirect_uris: (yield* allowedParties(sql, config)).map(
					(party) => `${party.expectedOrigin}${oidcCallbackPath}`,
				),
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			};
		});

		/** Providers the sign-in page offers: only those with an identity linked through the configured issuer. */
		const linkedProviders = Effect.map(linked, (identities) =>
			oidcProviders.filter((provider) =>
				identities.some((identity) => identity.issuer === issuer && identity.provider === provider),
			),
		);

		/** Discovery runs first and with no lock held; only the state row is written under the mutex. The browser
		 * keeps the binding in a cookie, so only the browser that started can finish. */
		const startOidc = (input: OidcStart, party: RelyingParty, sessionId: string | null) =>
			Effect.gen(function* () {
				const client = yield* enabled;
				const link = input.intent === "link";
				if (link && sessionId === null) return yield* refuse("session_invalid");
				// Signing in needs no credential, so it must name a provider with a linked identity before it writes a
				// row or asks the issuer anything: a board with nothing linked never starts a sign-in.
				if (!link && !(yield* linkedProviders).includes(input.provider)) return yield* refuse("identity_not_linked");
				const state = yield* random;
				const verifier = yield* random;
				const nonce = yield* random;
				const binding = yield* random;
				const challenge = Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
					"base64url",
				);
				const authorizationUrl = yield* client.authorizationUrl({
					response_type: "code",
					client_id: client.clientId,
					redirect_uri: `${party.expectedOrigin}${oidcCallbackPath}`,
					scope: "openid",
					state,
					nonce,
					code_challenge: challenge,
					code_challenge_method: "S256",
					provider: input.provider,
				});
				const record = yield* Schema.encodeEffect(Schema.fromJsonString(OidcState))({
					verifier,
					nonce,
					origin: party.expectedOrigin,
					// The approval page's same-origin path rule, which also refuses dot segments that collapse into "//host".
					next: link ? `/@${humanAgent}` : (approvalReturn(input.next ?? null, party.expectedOrigin) ?? "/"),
					binding_hash: yield* hash(binding),
				});
				yield* mutex.withPermit(
					Effect.gen(function* () {
						yield* passkeysUsable;
						if (link && sessionId !== null) yield* liveSession(sessionId);
						const now = yield* Clock.currentTimeMillis;
						yield* sql`DELETE FROM auth_challenges WHERE expires_at <= ${now}`;
						const live =
							yield* sql`SELECT id FROM auth_challenges WHERE ceremony IN ('oidc.login', 'oidc.link') LIMIT ${sql.literal(String(liveRoundTrips))}`;
						if (live.length >= liveRoundTrips) return yield* refuse("oidc_unavailable");
						yield* sql`INSERT INTO auth_challenges (id, challenge, ceremony, setup_generation, expires_at)
				VALUES (${state}, ${record}, ${link ? "oidc.link" : "oidc.login"}, ${link ? sessionId : null}, ${now + oidcLifetimeMs})`;
					}),
				);
				return { authorizationUrl, binding };
			});

		/** Whether a callback's state is a sign-in's or a link's, so its refusal page can say which; null for neither. */
		const oidcIntent = (state: string) =>
			Effect.map(
				sql`SELECT ceremony FROM auth_challenges WHERE id=${state}`.pipe(
					decodeRows(Schema.Struct({ ceremony: Schema.String })),
				),
				(rows) =>
					rows[0]?.ceremony === "oidc.link"
						? ("link" as const)
						: rows[0]?.ceremony === "oidc.login"
							? ("login" as const)
							: null,
			);

		/** Claim the state row before talking to the issuer, so a concurrent callback cannot spend it while this one is
		 * still redeeming. Issuer I/O holds no mutex. A claimed row is spent even if the callback is then refused, so a
		 * code that reached a browser without the binding cannot be replayed from the browser that holds it. */
		const finishOidc = (input: {
			readonly state: string;
			readonly code: string | undefined;
			readonly iss: string | undefined;
			readonly binding: string | null;
			/** The issuer sent the human back with an error instead of a code. */
			readonly refused: boolean;
		}) =>
			Effect.gen(function* () {
				const client = yield* enabled;
				const claimed = yield* mutex.withPermit(
					sql.withTransaction(
						lockBootWrite(sql).pipe(
							Effect.andThen(
								Effect.gen(function* () {
									const row =
										(yield* sql`SELECT ceremony, challenge, setup_generation, expires_at FROM auth_challenges WHERE id=${input.state}`.pipe(
											decodeRows(stateRow),
										))[0];
									if (!row || (row.ceremony !== "oidc.login" && row.ceremony !== "oidc.link")) return undefined;
									const taken = yield* take(input.state, row.ceremony, null);
									return taken === undefined
										? undefined
										: {
												ceremony: row.ceremony,
												challenge: taken.challenge,
												setup_generation: taken.setup_generation,
												expires_at: taken.expires_at,
											};
								}),
							),
						),
					),
				);
				if (claimed === undefined) return yield* refuse("oidc_invalid");
				const ceremony = claimed.ceremony;
				const code = input.code;
				if (
					input.refused ||
					code === undefined ||
					input.binding === null ||
					input.iss !== issuer ||
					claimed.expires_at <= (yield* Clock.currentTimeMillis)
				)
					return yield* refuse("oidc_invalid");
				const state = yield* Schema.decodeEffect(Schema.fromJsonString(OidcState))(claimed.challenge).pipe(
					Effect.mapError(() => new AuthError({ code: "oidc_invalid" })),
				);
				if (!same(yield* hash(input.binding), state.binding_hash)) return yield* refuse("oidc_invalid");
				const identity = yield* client.exchange(
					code,
					state.verifier,
					`${state.origin}${oidcCallbackPath}`,
					state.nonce,
				);
				const id = yield* identityId(identity.issuer, identity.subject);
				return yield* mutex.withPermit(
					committed(
						sql,
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							if (claimed.expires_at <= now) return yield* refuse("oidc_invalid");
							yield* passkeysUsable;
							if (!(yield* allowedParties(sql, config)).some((party) => party.expectedOrigin === state.origin))
								return yield* refuse("origin_invalid");
							const current = yield* stored(id);
							if (ceremony === "oidc.login") {
								const linkedIdentity = current === undefined ? Option.none() : decodeIdentity(current.value);
								if (Option.isNone(linkedIdentity)) return yield* refuse("identity_not_linked");
								const session = yield* newSession(state.origin);
								const value = yield* Schema.encodeEffect(Schema.fromJsonString(LinkedIdentity))({
									...linkedIdentity.value,
									last_used_at: now,
								});
								yield* sql`UPDATE settings SET value=${value} WHERE ${sql("key")}=${`${identityPrefix}${id}`}`;
								yield* event(
									"auth.oidc_login",
									{ identity: id, provider: identity.provider, issuer: identity.issuer, origin: state.origin },
									session.id,
								);
								return { _tag: "session" as const, session, next: state.next };
							}
							const sessionId = claimed.setup_generation;
							if (sessionId === null) return yield* refuse("oidc_invalid");
							yield* liveSession(sessionId);
							if (current !== undefined) return yield* refuse("identity_exists");
							const pending = yield* random;
							const record = yield* Schema.encodeEffect(Schema.fromJsonString(PendingLink))({
								issuer: identity.issuer,
								subject: identity.subject,
								provider: identity.provider,
								label: identity.label,
							});
							yield* sql`INSERT INTO auth_challenges (id, challenge, ceremony, setup_generation, expires_at)
				VALUES (${pending}, ${record}, 'identity.pending', ${sessionId}, ${now + oidcLifetimeMs})`;
							return { _tag: "pending" as const, next: `${state.next}?link=${pending}` };
						}).pipe(captureRefusal(Schema.is(AuthError))),
					),
				);
			});

		const listIdentities = (sessionId: string) =>
			mutex.withPermit(
				Effect.gen(function* () {
					yield* liveSession(sessionId);
					const now = yield* Clock.currentTimeMillis;
					const rows =
						yield* sql`SELECT id, challenge, expires_at FROM auth_challenges WHERE ceremony='identity.pending' AND setup_generation=${sessionId} AND expires_at>${now} ORDER BY expires_at DESC`.pipe(
							decodeRows(Schema.Struct({ id: Schema.String, challenge: Schema.String, expires_at: Schema.Finite })),
						);
					const pending = rows.flatMap((row) =>
						Option.match(Schema.decodeOption(Schema.fromJsonString(PendingLink))(row.challenge), {
							onNone: () => [],
							onSome: (link) => [
								{ id: row.id, provider: link.provider, label: link.label, expires_at: row.expires_at },
							],
						}),
					);
					return {
						// An identity linked through another issuer no longer signs in, but stays listed so it can be removed.
						identities: (yield* linked)
							.toSorted((left, right) => left.created_at - right.created_at)
							.map(({ subject: _subject, ...identity }) => ({ ...identity, active: identity.issuer === issuer })),
						pending,
						providers: issuer === null ? [] : [...oidcProviders],
					};
				}),
			);

		const linkIdentity = (params: IdentityAction, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (issuer === null) return yield* refuse("oidc_disabled");
						if (!validPendingId(params.id)) return yield* refuse("invalid_request");
						yield* verify("identity.link", canonicalIdentityLink(params, sessionId), proof);
						yield* liveSession(sessionId);
						const now = yield* Clock.currentTimeMillis;
						const taken = yield* take(params.id, "identity.pending", sessionId);
						const pending =
							taken === undefined || taken.expires_at <= now
								? Option.none()
								: Schema.decodeOption(Schema.fromJsonString(PendingLink))(taken.challenge);
						if (Option.isNone(pending)) return yield* refuse("identity_not_found");
						// A pending link verified by an issuer the board no longer uses would never sign in.
						if (pending.value.issuer !== issuer) return yield* refuse("oidc_invalid");
						const id = yield* identityId(pending.value.issuer, pending.value.subject);
						if ((yield* stored(id)) !== undefined) return yield* refuse("identity_exists");
						const identity = { ...pending.value, created_at: now, last_used_at: null };
						const value = yield* Schema.encodeEffect(Schema.fromJsonString(LinkedIdentity))(identity);
						yield* sql`INSERT INTO settings (${sql("key")}, value) VALUES (${`${identityPrefix}${id}`}, ${value})`;
						yield* event("auth.identity_linked", {
							identity: id,
							provider: identity.provider,
							issuer: identity.issuer,
						});
						const { subject: _subject, ...shown } = identity;
						return { id, ...shown, active: true };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);

		/** Sessions do not record how they were opened, so unlinking ends every other session. Only the session
		 * that just proved a passkey survives. */
		const unlinkIdentity = (params: IdentityAction, proof: AssertionProof, sessionId: string) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validIdentityId(params.id)) return yield* refuse("invalid_request");
						yield* verify("identity.unlink", canonicalIdentityUnlink(params, sessionId), proof);
						yield* liveSession(sessionId);
						const current = yield* stored(params.id);
						if (current === undefined) return yield* refuse("identity_not_found");
						yield* sql`DELETE FROM settings WHERE ${sql("key")}=${`${identityPrefix}${params.id}`}`;
						yield* sql`DELETE FROM sessions WHERE id<>${sessionId}`;
						const identity = decodeIdentity(current.value);
						yield* event("auth.identity_unlinked", {
							identity: params.id,
							provider: Option.isSome(identity) ? identity.value.provider : null,
							issuer: Option.isSome(identity) ? identity.value.issuer : null,
						});
						return { removed: params.id };
					}).pipe(captureRefusal(Schema.is(AuthError))),
				),
			);

		return {
			oidcClientDocument,
			startOidc,
			oidcIntent,
			finishOidc,
			listIdentities,
			linkIdentity,
			unlinkIdentity,
			linkedProviders,
		};
	});
