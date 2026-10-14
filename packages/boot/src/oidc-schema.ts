// Fixed-order arrays are deliberately serialized for identifiers and cryptographic bindings.
/* oxlint-disable effecttsgo/prefer-schema-over-json */
import { Crypto, Effect, Schema } from "effect";

/** Sign-in services boot can show a button for. A linked identity is still matched by issuer and subject only. */
export const oidcProviders = ["github", "google"] as const;
export const OidcProvider = Schema.Literals(oidcProviders);
export type OidcProvider = typeof OidcProvider.Type;

export const OidcStart = Schema.Struct({
	intent: Schema.Literals(["login", "link"]),
	provider: Schema.optionalKey(OidcProvider),
	next: Schema.optionalKey(Schema.String),
});
export type OidcStart = typeof OidcStart.Type;

/** A pending link (identity.link) or a linked identity (identity.unlink). */
export const IdentityAction = Schema.Struct({ id: Schema.String });
export type IdentityAction = typeof IdentityAction.Type;

/** Stored as the settings row `auth.identity:<id>`. */
export const LinkedIdentity = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	provider: OidcProvider,
	label: Schema.String,
	created_at: Schema.Finite,
	last_used_at: Schema.NullOr(Schema.Finite),
});
export type LinkedIdentity = typeof LinkedIdentity.Type;

/** An auth_challenges row for one sign-in round trip. The browser holds the binding; boot keeps only its hash. */
export const OidcState = Schema.Struct({
	verifier: Schema.String,
	nonce: Schema.String,
	origin: Schema.String,
	next: Schema.String,
	binding_hash: Schema.String,
});
export type OidcState = typeof OidcState.Type;

/** A verified identity waiting for the human's passkey before it is linked. */
export const PendingLink = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
	provider: OidcProvider,
	label: Schema.String,
});
export type PendingLink = typeof PendingLink.Type;

export const identityPrefix = "auth.identity:";
export const validPendingId = (id: string) => /^[A-Za-z0-9_-]{43}$/.test(id);
export const validIdentityId = (id: string) => /^[a-f0-9]{64}$/.test(id);

/** The digest fits the settings key column whatever the issuer and subject are. */
export const identityId = (issuer: string, subject: string) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const bytes = yield* crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify([issuer, subject])));
		return Buffer.from(bytes).toString("hex");
	});

// The challenge's ceremony names the action; the binding must fit the 128-character challenge column.
export const canonicalIdentityLink = (params: IdentityAction, sessionId: string) =>
	JSON.stringify([sessionId, params.id]);
export const canonicalIdentityUnlink = (params: IdentityAction, sessionId: string) =>
	JSON.stringify([sessionId, params.id]);
