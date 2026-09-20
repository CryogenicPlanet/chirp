import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Invitations } from "../src/invitations.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { runFresh } from "./fixture.ts";

const invitationRows = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ token_digest: Schema.String, email: Schema.String })),
);

describe("Invitations", () => {
	test("stores only a digest and returns the secret once", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const invitations = yield* Invitations;
				const sql = yield* SqlClient.SqlClient;
				const issued = yield* invitations.issue(" Person@Example.COM ", 60_000);
				expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(issued.invitation.email).toBe("person@example.com");
				const stored = yield* sql`SELECT token_digest, email FROM cloud_invitations`.pipe(
					Effect.flatMap(invitationRows),
				);
				expect(stored).toHaveLength(1);
				expect(stored[0]?.token_digest).toMatch(/^[0-9a-f]{64}$/);
				expect(stored[0]?.token_digest).not.toContain(issued.token);
			}),
		);
	});
});
