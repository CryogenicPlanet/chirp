import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { cloudInvitation } from "../src/auth-schema.ts";
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
});
