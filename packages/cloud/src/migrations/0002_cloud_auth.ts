import { Effect } from "effect";
import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../database.ts";

export const id = 2;
export const name = "cloud_auth";
export const compatibleSchemaVersions: ReadonlyArray<number> = [1];

export const effect = (database: DatabaseClient) =>
	Effect.gen(function* () {
		yield* database.execute(sql`CREATE TABLE "user" (
			"id" TEXT PRIMARY KEY,
			"name" TEXT NOT NULL,
			"email" TEXT NOT NULL UNIQUE,
			"emailVerified" BOOLEAN NOT NULL,
			"image" TEXT,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		yield* database.execute(sql`CREATE TABLE "session" (
			"id" TEXT PRIMARY KEY,
			"expiresAt" TIMESTAMPTZ NOT NULL,
			"token" TEXT NOT NULL UNIQUE,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" TIMESTAMPTZ NOT NULL,
			"ipAddress" TEXT,
			"userAgent" TEXT,
			"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
		)`);
		yield* database.execute(sql`CREATE TABLE "account" (
			"id" TEXT PRIMARY KEY,
			"accountId" TEXT NOT NULL,
			"providerId" TEXT NOT NULL,
			"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
			"accessToken" TEXT,
			"refreshToken" TEXT,
			"idToken" TEXT,
			"accessTokenExpiresAt" TIMESTAMPTZ,
			"refreshTokenExpiresAt" TIMESTAMPTZ,
			"scope" TEXT,
			"password" TEXT,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" TIMESTAMPTZ NOT NULL
		)`);
		yield* database.execute(sql`CREATE TABLE "verification" (
			"id" TEXT PRIMARY KEY,
			"identifier" TEXT NOT NULL,
			"value" TEXT NOT NULL,
			"expiresAt" TIMESTAMPTZ NOT NULL,
			"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			"updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`);
		yield* database.execute(sql`CREATE TABLE cloud_invitations (
			id TEXT PRIMARY KEY,
			token_digest TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ NOT NULL
		)`);
		yield* database.execute(sql`CREATE TABLE passkey (
			id TEXT PRIMARY KEY,
			name TEXT,
			"publicKey" TEXT NOT NULL,
			"userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
			"credentialID" TEXT NOT NULL,
			counter BIGINT NOT NULL,
			"deviceType" TEXT NOT NULL,
			"backedUp" BOOLEAN NOT NULL,
			transports TEXT,
			"createdAt" TIMESTAMPTZ,
			aaguid TEXT
		)`);
		yield* database.execute(sql`CREATE TABLE "rateLimit" (
			id TEXT PRIMARY KEY,
			key TEXT NOT NULL UNIQUE,
			count INTEGER NOT NULL,
			"lastRequest" BIGINT NOT NULL
		)`);
		yield* database.execute(sql`CREATE INDEX "session_userId_idx" ON "session" ("userId")`);
		yield* database.execute(sql`CREATE INDEX "account_userId_idx" ON "account" ("userId")`);
		yield* database.execute(sql`CREATE INDEX verification_identifier_idx ON verification (identifier)`);
		yield* database.execute(sql`CREATE INDEX cloud_invitations_email_idx ON cloud_invitations (email)`);
		yield* database.execute(sql`CREATE INDEX "passkey_userId_idx" ON passkey ("userId")`);
		yield* database.execute(sql`CREATE INDEX "passkey_credentialID_idx" ON passkey ("credentialID")`);
	});
