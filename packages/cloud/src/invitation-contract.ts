import { Schema } from "effect";

export const InvitationEmail = Schema.String.check(
	Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
	Schema.isMaxLength(254),
);
export const InvitationCreateRequest = Schema.Struct({ email: InvitationEmail });
export const InvitationCapability = Schema.Struct({ can_invite: Schema.Boolean });
export const InvitationCreated = Schema.Struct({ url: Schema.String, expires_at: Schema.String });
