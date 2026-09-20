import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	id: text().primaryKey(),
	name: text().notNull(),
	email: text().notNull().unique(),
	emailVerified: boolean().notNull(),
	image: text(),
	createdAt: timestamp({ withTimezone: true }).notNull(),
	updatedAt: timestamp({ withTimezone: true }).notNull(),
});

export const session = pgTable(
	"session",
	{
		id: text().primaryKey(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		token: text().notNull().unique(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull(),
		ipAddress: text(),
		userAgent: text(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text().primaryKey(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamp({ withTimezone: true }),
		refreshTokenExpiresAt: timestamp({ withTimezone: true }),
		scope: text(),
		password: text(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull(),
	},
	(table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
	"verification",
	{
		id: text().primaryKey(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const cloudInvitation = pgTable(
	"cloud_invitations",
	{
		id: text().primaryKey(),
		token_digest: text().notNull().unique(),
		email: text().notNull(),
		expires_at: timestamp({ withTimezone: true }).notNull(),
		created_at: timestamp({ withTimezone: true }).notNull(),
	},
	(table) => [index("cloud_invitations_email_idx").on(table.email)],
);

export const passkey = pgTable(
	"passkey",
	{
		id: text().primaryKey(),
		name: text(),
		publicKey: text().notNull(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		credentialID: text().notNull(),
		counter: integer().notNull(),
		deviceType: text().notNull(),
		backedUp: boolean().notNull(),
		transports: text(),
		createdAt: timestamp({ withTimezone: true }),
		aaguid: text(),
	},
	(table) => [index("passkey_userId_idx").on(table.userId), index("passkey_credentialID_idx").on(table.credentialID)],
);

export const rateLimit = pgTable("rateLimit", {
	id: text().primaryKey(),
	key: text().notNull().unique(),
	count: integer().notNull(),
	lastRequest: bigint({ mode: "number" }).notNull(),
});

export const authSchema = {
	user,
	session,
	account,
	verification,
	cloud_invitations: cloudInvitation,
	passkey,
	rateLimit,
};
