import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { cloudInvitation, cloudInvitationLimits } from "../src/auth-schema.ts";
import { Database } from "../src/database.ts";
import { Invitations } from "../src/invitations.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { runFresh } from "./fixture.ts";

describe("Invitations", () => {
	test("stores only a digest and returns the secret once", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				const database = yield* Database;
				const issued = yield* invitations.issue(" Person@Example.COM ", 60_000);
				expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(issued.invitation.email).toBe("person@example.com");
				const stored = yield* database
					.select({ tokenDigest: cloudInvitation.token_digest, email: cloudInvitation.email })
					.from(cloudInvitation);
				expect(stored).toHaveLength(1);
				expect(stored[0]?.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
				expect(stored[0]?.tokenDigest).not.toContain(issued.token);
			}),
		);
	});
	test("operator access is fail-closed and uses normalized exact email matches", async () => {
		await runFresh(
			Effect.gen(function* () {
				const invitations = yield* Invitations;
				expect(
					yield* invitations
						.canIssue("owner@example.com")
						.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
				).toBe(false);
				expect(yield* invitations.canIssue(" Owner@Example.COM ")).toBe(true);
				expect(yield* invitations.canIssue("someone@example.com")).toBe(false);
				const rejected = yield* invitations
					.issueForOperator({ id: "outsider", email: "someone@example.com" })
					.pipe(Effect.exit);
				expect(Exit.isFailure(rejected)).toBe(true);
			}).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ CLOUD_OPERATOR_EMAILS: " Owner@Example.COM " }),
				),
			),
		);
	});

	test("caps concurrent issuance, retains quota after consumption, and renews the next window", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				const database = yield* Database;
				const issuer = { id: "operator", email: "owner@example.com" };
				const attempts = yield* Effect.all(
					Array.from({ length: 25 }, () => invitations.issueForOperator(issuer).pipe(Effect.exit)),
					{ concurrency: "unbounded" },
				);
				expect(attempts.filter(Exit.isSuccess)).toHaveLength(20);
				expect(attempts.filter(Exit.isFailure)).toHaveLength(5);
				const rows = yield* database.select().from(cloudInvitation);
				expect(rows).toHaveLength(20);
				expect(rows.every((row) => row.email === null)).toBe(true);
				expect(rows.every((row) => row.expires_at.getTime() - row.created_at.getTime() === 86_400_000)).toBe(true);
				yield* database.delete(cloudInvitation);
				expect(Exit.isFailure(yield* invitations.issueForOperator(issuer).pipe(Effect.exit))).toBe(true);
				expect(
					Exit.isSuccess(yield* invitations.issueForOperator({ ...issuer, id: "another-operator" }).pipe(Effect.exit)),
				).toBe(true);
				yield* database
					.update(cloudInvitationLimits)
					.set({ window_start: 0 })
					.where(eq(cloudInvitationLimits.issuer_id, issuer.id));
				expect(Exit.isSuccess(yield* invitations.issueForOperator(issuer).pipe(Effect.exit))).toBe(true);
				const limit = yield* database
					.select()
					.from(cloudInvitationLimits)
					.where(eq(cloudInvitationLimits.issuer_id, issuer.id));
				expect(limit[0]?.count).toBe(1);
			}).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ CLOUD_OPERATOR_EMAILS: "owner@example.com" }),
				),
			),
		);
	});

	test("invalid legacy-bound recipients are rejected", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				const database = yield* Database;
				for (const email of ["invalid", "a@@example.com", `${"a".repeat(250)}@example.com`]) {
					expect(Exit.isFailure(yield* invitations.issue(email, 60_000).pipe(Effect.exit))).toBe(true);
				}
				expect(yield* database.select().from(cloudInvitationLimits)).toHaveLength(0);
				expect(yield* database.select().from(cloudInvitation)).toHaveLength(0);
			}).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ CLOUD_OPERATOR_EMAILS: "owner@example.com" }),
				),
			),
		);
	});
});
