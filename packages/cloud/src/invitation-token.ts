import { Schema } from "effect";

export const InvitationToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export type InvitationToken = typeof InvitationToken.Type;
