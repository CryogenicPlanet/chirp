import { Buffer } from "node:buffer";
import { sql } from "drizzle-orm";
import { Config, Context, Crypto, Data, DateTime, Effect, Layer, Schema } from "effect";
import { cloudInvitation, cloudInvitationLimits } from "./auth-schema.ts";
import { Database, type DatabaseClient } from "./database.ts";
import { InvitationEmail } from "./invitation-contract.ts";
import type { InvitationToken } from "./invitation-token.ts";

export interface CloudInvitation {
	readonly id: string;
	readonly email: string | null;
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

export class InvitationsForbidden extends Data.TaggedError("InvitationsForbidden")<{}> {}
export class InvitationRateLimited extends Data.TaggedError("InvitationRateLimited")<{}> {}

const canIssue = (email: string) =>
	Config.String("CLOUD_OPERATOR_EMAILS").pipe(
		Config.withDefault(""),
		Effect.map((value) =>
			value
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean)
				.includes(email.trim().toLowerCase()),
		),
	);

const make = Effect.gen(function* () {
	const database = yield* Database;
	const crypto = yield* Crypto.Crypto;
	const issue = (email: string | null, validForMilliseconds: number, target: DatabaseClient = database) =>
		Effect.gen(function* () {
			const normalizedEmail = email === null ? null : email.trim().toLowerCase();
			if (normalizedEmail !== null && !Schema.is(InvitationEmail)(normalizedEmail))
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
			const created = yield* target
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
		});
	return {
		issue,
		canIssue,
		issueForOperator: (issuer: { readonly id: string; readonly email: string }) =>
			Effect.gen(function* () {
				if (!(yield* canIssue(issuer.email))) return yield* new InvitationsForbidden();
				const now = (yield* DateTime.nowAsDate).getTime();
				const cutoff = now - 60 * 60 * 1_000;
				return yield* database.transaction((transaction) =>
					Effect.gen(function* () {
						const claimed = yield* transaction
							.insert(cloudInvitationLimits)
							.values({ issuer_id: issuer.id, window_start: now, count: 1 })
							.onConflictDoUpdate({
								target: cloudInvitationLimits.issuer_id,
								set: {
									count: sql`CASE WHEN ${cloudInvitationLimits.window_start} <= ${cutoff} THEN 1 ELSE ${cloudInvitationLimits.count} + 1 END`,
									window_start: sql`CASE WHEN ${cloudInvitationLimits.window_start} <= ${cutoff} THEN ${now} ELSE ${cloudInvitationLimits.window_start} END`,
								},
								setWhere: sql`${cloudInvitationLimits.window_start} <= ${cutoff} OR ${cloudInvitationLimits.count} < 20`,
							})
							.returning({ count: cloudInvitationLimits.count });
						if (claimed.length === 0) return yield* new InvitationRateLimited();
						return yield* issue(null, 24 * 60 * 60 * 1_000, transaction);
					}),
				);
			}),
	};
});

export class Invitations extends Context.Service<Invitations, Effect.Success<typeof make>>()(
	"comms/cloud/Invitations",
) {}
export const invitationsLayer = Layer.effect(Invitations, make);
