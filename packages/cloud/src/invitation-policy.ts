import { Data, Effect, Schema } from "effect";
import { InvitationToken } from "./invitation-token.ts";

export interface InvitationIdentity {
	readonly user: Readonly<Record<string, unknown>>;
	readonly source: {
		readonly action: string;
		readonly method: string;
	};
}

export interface InvitationClaim {
	readonly tokenDigest: string;
	readonly email: string;
	readonly after: Date;
}

export class InvitationPolicyError extends Data.TaggedError("InvitationPolicyError")<{
	readonly cause: unknown;
}> {}

export interface InvitationPolicyDependencies {
	readonly readToken: Effect.Effect<unknown, InvitationPolicyError>;
	readonly digest: (token: string) => Effect.Effect<string, InvitationPolicyError>;
	readonly now: Effect.Effect<Date, InvitationPolicyError>;
	readonly consume: (claim: InvitationClaim) => Effect.Effect<boolean, InvitationPolicyError>;
}

export interface InvitationRejection {
	readonly error: string;
	readonly errorDescription: string;
}

const rejected = (error: string): InvitationRejection => ({
	error,
	errorDescription: "A valid invitation is required to create a Chirp Cloud account",
});

export const checkInvitation = (identity: InvitationIdentity, dependencies: InvitationPolicyDependencies) =>
	Effect.gen(function* () {
		if (identity.source.action === "sign-in") return;
		if (identity.source.action === "link-account") return;
		if (identity.source.action !== "create-user" || identity.source.method !== "oauth")
			return rejected("invitation_required");
		const email = identity.user.email;
		if (typeof email !== "string" || identity.user.emailVerified !== true) return rejected("verified_email_required");
		const token = yield* dependencies.readToken;
		if (typeof token !== "string" || !Schema.is(InvitationToken)(token)) return rejected("invitation_required");
		const consumed = yield* dependencies.consume({
			tokenDigest: yield* dependencies.digest(token),
			email: email.trim().toLowerCase(),
			after: yield* dependencies.now,
		});
		if (!consumed) return rejected("invitation_invalid");
	});
