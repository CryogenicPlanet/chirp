import { lockBootWrite } from "./boot-write-lock.ts";
import { humanAgent } from "./human-agent.ts";
import { authSecrets, refuse, committed, captureRefusal } from "./auth-primitives.ts";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Clock, Crypto, Effect, Schema, Struct, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AuthError } from "./auth.ts";
import { Events } from "./events.ts";
import { expireRefreshReceipts, Token } from "./refresh-schema.ts";
import { validFamily } from "./refresh-schema.ts";
import {
	canonicalScopes,
	heldAccessSeconds,
	heldExtension,
	heldKindPrefix,
	Scope,
	type EnrollmentDecision,
	validDecision,
	validExtensionName,
} from "./enrollment-schema.ts";

export interface AssertionProof {
	readonly id: string;
	readonly response: AuthenticationResponseJSON;
}
export interface VerifiedIdentity {
	readonly id: string;
	readonly agent: string;
	readonly kind: "human" | "agent";
	readonly label: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number;
	/** The extension a held grant acts through. Boot keeps that credential; the app only names the family. */
	readonly held?: string;
}
const enrollmentRow = Schema.Struct({
	id: Schema.String,
	device_secret_hash: Schema.String,
	user_code: Schema.String,
	agent_name: Schema.String,
	kind: Schema.String,
	host: Schema.String,
	status: Schema.String,
	family: Schema.String,
	created_at: Schema.Int,
	expires_at: Schema.Int,
	collected_at: Schema.NullOr(Schema.Int),
	scopes: Schema.NullOr(Schema.String),
	access_seconds: Schema.NullOr(Schema.Int),
	refresh_seconds: Schema.NullOr(Schema.Int),
});
const tokenRow = Token.mapFields(Struct.pick(["id", "family", "agent", "label", "scopes", "expires_at", "revoked_at"]));
const agentName = (name: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && name !== humanAgent && name !== "boot";
const hostName = (host: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(host);
/** What a held collection reports. It never carries a secret: boot keeps the only access row's preimage-free hash. */
export type HeldCollection =
	| { readonly status: "pending"; readonly expires_at: number }
	| { readonly status: "denied" | "expired" }
	| { readonly status: "revoked" | "expired"; readonly family: string }
	| {
			readonly status: "approved";
			readonly family: string;
			readonly agent: string;
			readonly label: string;
			readonly scopes: readonly string[];
			readonly expires_at: number;
	  };

/** Enrollment and collection share the passkey service's admission mutex and boot transaction. */
export const makeEnrollment = <E, R>(
	verify: (params: EnrollmentDecision, proof: AssertionProof) => Effect.Effect<void, E, R>,
	mutex: Semaphore.Semaphore,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const crypto = yield* Crypto.Crypto;
		const events = yield* Events;
		const { hash, random } = authSecrets(crypto);
		const read = (id: string) =>
			sql`SELECT * FROM enrollments WHERE id=${id}`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))),
				Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : refuse("enrollment_invalid"))),
			);
		const enrollmentInfo = (id: string) =>
			Effect.gen(function* () {
				const row = yield* read(id);
				const held = heldExtension(row.kind);
				return {
					id: row.id,
					name: row.agent_name,
					kind: row.kind,
					host: row.host,
					held,
					// A held row records the scopes its extension asked for; the human can only narrow them.
					requested:
						held !== null && row.status === "pending" && row.scopes !== null
							? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(row.scopes)
							: null,
					user_code: row.user_code,
					status:
						row.expires_at <= (yield* Clock.currentTimeMillis) && row.status !== "collected" && row.status !== "denied"
							? "expired"
							: row.status,
					expires_at: row.expires_at,
				};
			});
		const createEnrollment = (input: { readonly name: string; readonly kind: string; readonly host: string }) =>
			Effect.gen(function* () {
				if (!agentName(input.name) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.kind) || !hostName(input.host))
					return yield* refuse("invalid_request");
				const id = `e_${yield* random}`,
					secret = yield* random,
					family = `f_${yield* random}`;
				const digest = yield* hash(secret),
					code = Buffer.from(yield* crypto.randomBytes(3))
						.toString("hex")
						.toUpperCase();
				const now = yield* Clock.currentTimeMillis,
					expires = now + 600_000;
				yield* sql`INSERT INTO enrollments(id,device_secret_hash,user_code,agent_name,kind,host,status,family,created_at,expires_at)
   VALUES(${id},${digest},${code},${input.name},${input.kind},${input.host},'pending',${family},${now},${expires})`;
				return { id, device_secret: secret, user_code: code, expires_at: expires };
			});
		/** Only the live app's private channel reaches this. The device secret's hash covers a value nobody keeps,
		 * so neither this image nor an older one can collect the row through the public route. */
		const createHeldEnrollment = (input: {
			readonly extension: string;
			readonly agent: string;
			readonly label: string;
			readonly scopes: readonly string[];
		}) =>
			Effect.gen(function* () {
				if (
					!validExtensionName(input.extension) ||
					!agentName(input.agent) ||
					!hostName(input.label) ||
					!input.scopes.includes("read") ||
					new Set(input.scopes).size !== input.scopes.length ||
					canonicalScopes(input.scopes).length !== input.scopes.length
				)
					return yield* refuse("invalid_request");
				const id = `e_${yield* random}`,
					family = `f_${yield* random}`;
				const digest = yield* hash(yield* random),
					code = Buffer.from(yield* crypto.randomBytes(3))
						.toString("hex")
						.toUpperCase();
				const scopes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
					canonicalScopes(input.scopes),
				);
				const now = yield* Clock.currentTimeMillis,
					expires = now + 600_000;
				yield* sql`INSERT INTO enrollments(id,device_secret_hash,user_code,agent_name,kind,host,status,family,created_at,expires_at,scopes)
   VALUES(${id},${digest},${code},${input.agent},${heldKindPrefix + input.extension},${input.label},'pending',${family},${now},${expires},${scopes})`;
				return { id, expires_at: expires };
			});
		const decideEnrollment = (params: EnrollmentDecision, proof: AssertionProof) =>
			mutex.withPermit(
				committed(
					sql,
					Effect.gen(function* () {
						if (!validDecision(params)) return yield* refuse("invalid_request");
						yield* verify(params, proof);
						// A valid proof is consumed even if the pending enrollment became terminal. SQL failures still roll everything back.
						return yield* Effect.gen(function* () {
							const row = yield* read(params.id),
								now = yield* Clock.currentTimeMillis;
							if (row.expires_at <= now) return yield* refuse("enrollment_expired");
							if (row.status !== "pending") return yield* refuse("enrollment_decided");
							const held = heldExtension(row.kind);
							if (held !== null) {
								// A grant's lifetime is fixed, and the human may only narrow what the extension asked for.
								const requested = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(
									row.scopes ?? "[]",
								);
								if (params.long_lived || params.scopes.some((scope) => !requested.includes(scope)))
									return yield* refuse("invalid_request");
							}
							const scopes = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
								canonicalScopes(params.scopes),
							);
							const access = held !== null ? heldAccessSeconds : params.long_lived ? 604800 : 86400,
								refresh = held !== null ? null : params.long_lived ? 7776000 : 2592000;
							yield* sql`UPDATE enrollments SET status=${params.decision === "approve" ? "approved" : "denied"},scopes=${scopes},access_seconds=${access},refresh_seconds=${refresh} WHERE id=${params.id}`;
							// A held approval guards no device secret: give the extension a full window from the decision.
							if (held !== null && params.decision === "approve")
								yield* sql`UPDATE enrollments SET expires_at=${now + 600_000} WHERE id=${params.id}`;
							yield* events.writeBoot({
								at: now,
								type: params.decision === "approve" ? "enrollment.approved" : "enrollment.denied",
								level: "info",
								actor: humanAgent,
								instance: null,
								generation: 0,
								request_id: null,
								topic: null,
								message_id: null,
								payload: {
									id: params.id,
									agent: row.agent_name,
									label: row.host,
									scopes: params.scopes,
									long_lived: params.long_lived,
									...(held === null ? {} : { held_by: held }),
								},
							});
							return { status: params.decision === "approve" ? "approved" : "denied" };
						}).pipe(captureRefusal(Schema.is(AuthError)));
					}),
				),
			);
		const collectEnrollment = (id: string, secret: string) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return yield* refuse("device_secret_invalid");
						const digest = yield* hash(secret);
						const rows = yield* sql`SELECT * FROM enrollments WHERE id=${id} AND device_secret_hash=${digest}`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))),
						);
						const row = rows[0];
						// A held row never matches a supplied secret; refuse it by kind as well.
						if (!row || heldExtension(row.kind) !== null) return yield* refuse("device_secret_invalid");
						if (row.status === "collected") return yield* refuse("already_collected");
						if (row.status === "denied") return yield* refuse("enrollment_denied");
						const now = yield* Clock.currentTimeMillis;
						if (row.expires_at <= now) return yield* refuse("enrollment_expired");
						if (row.status === "pending") return { status: "pending" as const, expires_at: row.expires_at };
						if (row.status !== "approved" || !row.scopes || !row.access_seconds || !row.refresh_seconds)
							return yield* refuse("enrollment_invalid");
						const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Scope)))(row.scopes);
						const access = yield* random,
							refresh = yield* random,
							pair = `p_${yield* random}`;
						const expires = now + row.access_seconds * 1000,
							refreshExpires = now + row.refresh_seconds * 1000;
						for (const [kind, token, expiry] of [
							["access", access, expires],
							["refresh", refresh, refreshExpires],
						] as const) {
							const tokenId = `t_${yield* random}`,
								tokenHash = yield* hash(token);
							yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at)
    VALUES(${tokenId},${pair},${row.family},${row.agent_name},${kind},${tokenHash},${row.host},${row.scopes},${expiry},${now})`;
						}
						yield* sql`UPDATE enrollments SET status='collected',collected_at=${now} WHERE id=${id}`;
						return {
							status: "collected" as const,
							agent: row.agent_name,
							access,
							refresh,
							expires_at: expires,
							refresh_expires_at: refreshExpires,
							scopes,
							label: row.host,
							family: row.family,
						};
					}),
				),
			);
		/** Idempotent and serialized: the first approved collection writes the family's only access row. */
		const collectHeldEnrollment = (id: string, extension: string) =>
			mutex.withPermit(
				sql.withTransaction(
					Effect.gen(function* () {
						yield* lockBootWrite(sql);
						if (!/^e_[A-Za-z0-9_-]{43}$/.test(id) || !validExtensionName(extension))
							return yield* refuse("enrollment_invalid");
						const row =
							(yield* sql`SELECT * FROM enrollments WHERE id=${id} AND kind=${heldKindPrefix + extension}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(enrollmentRow))),
							))[0];
						if (!row) return yield* refuse("enrollment_invalid");
						const now = yield* Clock.currentTimeMillis;
						if (row.status === "denied") return { status: "denied" } satisfies HeldCollection;
						if (row.status === "pending")
							return (
								row.expires_at <= now ? { status: "expired" } : { status: "pending", expires_at: row.expires_at }
							) satisfies HeldCollection;
						if (row.status === "approved") {
							if (row.expires_at <= now) return { status: "expired" } satisfies HeldCollection;
							// Only this image's decision writes a held approval; anything else stays inert.
							if (row.scopes === null || row.access_seconds !== heldAccessSeconds || row.refresh_seconds !== null)
								return yield* refuse("enrollment_invalid");
							yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at)
    VALUES(${`t_${yield* random}`},${`p_${yield* random}`},${row.family},${row.agent_name},'access',${yield* hash(yield* random)},${row.host},${row.scopes},${now + heldAccessSeconds * 1000},${now})`;
							yield* sql`UPDATE enrollments SET status='collected',collected_at=${now} WHERE id=${id}`;
						} else if (row.status !== "collected") return yield* refuse("enrollment_invalid");
						const tokens =
							yield* sql`SELECT id,family,agent,label,scopes,expires_at,revoked_at FROM tokens WHERE family=${row.family} AND kind='access'`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(tokenRow))),
							);
						const token = tokens[0];
						if (!token || tokens.length !== 1) return yield* refuse("enrollment_invalid");
						if (token.revoked_at !== null) return { status: "revoked", family: token.family } satisfies HeldCollection;
						if (token.expires_at <= now) return { status: "expired", family: token.family } satisfies HeldCollection;
						return {
							status: "approved",
							family: token.family,
							agent: token.agent,
							label: token.label,
							scopes: token.scopes,
							expires_at: token.expires_at,
						} satisfies HeldCollection;
					}),
				),
			);
		/** Use evidence is stamped the moment a grant authenticates, as for a bearer token. */
		const authenticateGrant = (family: string, extension: string) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* lockBootWrite(sql);
					if (!validFamily(family) || !validExtensionName(extension)) return yield* refuse("grant_invalid");
					const now = yield* Clock.currentTimeMillis;
					const rows =
						yield* sql`SELECT t.id,t.family,t.agent,t.label,t.scopes,t.expires_at,t.revoked_at FROM tokens t JOIN enrollments e ON e.family=t.family
		WHERE t.family=${family} AND t.kind='access' AND e.kind=${heldKindPrefix + extension} AND e.status='collected'`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(tokenRow))),
						);
					const row = rows[0];
					if (!row || rows.length !== 1 || row.revoked_at !== null) return yield* refuse("grant_invalid");
					if (row.expires_at <= now) return yield* refuse("grant_expired");
					yield* sql`UPDATE tokens SET last_used_at=${now} WHERE id=${row.id}`;
					return {
						id: row.family,
						agent: row.agent,
						kind: "agent",
						label: row.label,
						scopes: row.scopes,
						expiresAt: row.expires_at,
						held: extension,
					} satisfies VerifiedIdentity;
				}),
			);
		const authenticateAccess = (token: string) =>
			sql.withTransaction(
				Effect.gen(function* () {
					yield* lockBootWrite(sql);
					if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return yield* refuse("token_invalid");
					const digest = yield* hash(token),
						now = yield* Clock.currentTimeMillis;
					const rows =
						yield* sql`SELECT id,family,agent,label,scopes,expires_at,revoked_at FROM tokens WHERE hash=${digest} AND kind='access'`.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(tokenRow))),
						);
					const row = rows[0];
					if (!row || row.revoked_at !== null) return yield* refuse("token_invalid");
					if (row.expires_at <= now) return yield* refuse("token_expired");
					yield* sql`UPDATE tokens SET last_used_at=${now} WHERE id=${row.id}`;
					yield* expireRefreshReceipts(sql, now);
					return {
						id: row.family,
						agent: row.agent,
						kind: "agent",
						label: row.label,
						scopes: row.scopes,
						expiresAt: row.expires_at,
					} satisfies VerifiedIdentity;
				}),
			);
		return {
			createEnrollment,
			createHeldEnrollment,
			enrollmentInfo,
			decideEnrollment,
			collectEnrollment,
			collectHeldEnrollment,
			authenticateAccess,
			authenticateGrant,
		};
	});
