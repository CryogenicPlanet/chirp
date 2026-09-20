import { Buffer } from "node:buffer";
import { Context, Crypto, Data, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { InvitationToken } from "./invitation-token.ts";

export const CloudInvitation = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	expires_at: Schema.DateFromString,
	created_at: Schema.DateFromString,
});
export type CloudInvitation = typeof CloudInvitation.Type;

export interface IssuedInvitation {
	readonly invitation: CloudInvitation;
	readonly token: InvitationToken;
}

export class InvalidInvitation extends Data.TaggedError("InvalidInvitation")<{
	readonly message: string;
}> {}

const invitations = Schema.decodeUnknownEffect(Schema.Array(CloudInvitation));

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	return {
		issue: (email: string, validForMilliseconds: number) =>
			Effect.gen(function* () {
				const normalizedEmail = email.trim().toLowerCase();
				if (!/^\S+@\S+\.\S+$/.test(normalizedEmail))
					return yield* new InvalidInvitation({ message: "Invitation email is invalid" });
				if (!Number.isSafeInteger(validForMilliseconds) || validForMilliseconds <= 0)
					return yield* new InvalidInvitation({ message: "Invitation lifetime must be a positive integer" });
				const [id, tokenBytes, now] = yield* Effect.all([crypto.randomUUIDv7, crypto.randomBytes(32), DateTime.now]);
				const token: InvitationToken = Buffer.from(tokenBytes).toString("base64url");
				const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(token));
				let tokenDigest = "";
				for (const byte of digest) tokenDigest += byte.toString(16).padStart(2, "0");
				const createdAt = DateTime.toDateUtc(now);
				const expiresAt = DateTime.toDateUtc(DateTime.addDuration(now, validForMilliseconds));
				const created = yield* sql`INSERT INTO cloud_invitations (
					id, token_digest, email, expires_at, created_at
				) VALUES (
					${id}, ${tokenDigest}, ${normalizedEmail}, ${expiresAt}, ${createdAt}
				) RETURNING id, email, expires_at::text AS expires_at, created_at::text AS created_at`.pipe(
					Effect.flatMap(invitations),
				);
				const invitation = created[0];
				if (!invitation) return yield* Effect.die("Invitation insert returned no row");
				return { invitation, token } satisfies IssuedInvitation;
			}),
	};
});

export class Invitations extends Context.Service<Invitations, Effect.Success<typeof make>>()(
	"comms/cloud/Invitations",
) {}
export const invitationsLayer = Layer.effect(Invitations, make);
