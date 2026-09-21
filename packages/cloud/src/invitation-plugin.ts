import type { BetterAuthPlugin } from "better-auth";

export const invitationPlugin = {
	id: "chirp-cloud-invitations",
	schema: {
		cloudInvitation: {
			modelName: "cloud_invitations",
			fields: {
				tokenDigest: {
					type: "string",
					required: true,
					unique: true,
					fieldName: "token_digest",
				},
				email: {
					type: "string",
					required: false,
					index: true,
				},
				expiresAt: {
					type: "date",
					required: true,
					fieldName: "expires_at",
				},
				createdAt: {
					type: "date",
					required: true,
					fieldName: "created_at",
				},
			},
		},
	},
} satisfies BetterAuthPlugin;
