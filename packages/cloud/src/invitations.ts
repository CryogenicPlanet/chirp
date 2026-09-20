import { Buffer } from "node:buffer";
import { Context, Crypto, Data, DateTime, Effect, Layer } from "effect";
import { cloudInvitation } from "./auth-schema.ts";
import { Database } from "./database.ts";
import type { InvitationToken } from "./invitation-token.ts";

export interface CloudInvitation {
	readonly id: string;
	readonly email: string;
	readonly expires_at: Date;
	readonly created_at: Date;
}

export interface IssuedInvitation {
	readonly invitation: CloudInvitation;
	readonly token: InvitationToken;
}

export class InvalidInvitation extends Data.TaggedError("InvalidInvitation")<{
	readonly message: string;
}> {}

const make = Effect.gen(function* () {
	const database = yield* Database;
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
				const created = yield* database
					.insert(cloudInvitation)
					.values({
						id,
						token_digest: tokenDigest,
						email: normalizedEmail,
						expires_at: expiresAt,
						created_at: createdAt,
					})
					.returning({
						id: cloudInvitation.id,
						email: cloudInvitation.email,
						expires_at: cloudInvitation.expires_at,
						created_at: cloudInvitation.created_at,
					});
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
