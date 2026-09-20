import { betterAuth } from "better-auth";
import { Data, DateTime } from "effect";
import { Pool } from "pg";
import { describe, expect, test } from "vitest";
import { invitationPlugin } from "../src/invitation-plugin.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { realPostgres, runFresh } from "./fixture.ts";

class RollbackProbe extends Data.TaggedError("RollbackProbe") {}

const auth = (pool: Pool) =>
	betterAuth({
		baseURL: "https://cloud.test",
		secret: "test-auth-secret-with-at-least-32-characters",
		database: pool,
		plugins: [invitationPlugin],
	});
type Adapter = Awaited<ReturnType<typeof auth>["$context"]>["adapter"];

const withAdapter = async <A>(use: (adapter: Adapter) => Promise<A>) => {
	const pool = new Pool({ connectionString: process.env.CLOUD_TEST_DATABASE_URL });
	try {
		return await use((await auth(pool).$context).adapter);
	} finally {
		await pool.end();
	}
};

const invitation = (id: string) => ({
	id,
	tokenDigest: id.padEnd(64, "0"),
	email: "person@example.com",
	expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe(60_000)),
	createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
});

describe.skipIf(!realPostgres)("invitation adapter", () => {
	test("allows exactly one concurrent consumer", async () => {
		await runFresh(migrateCloudDatabase);
		await withAdapter(async (adapter) => {
			await adapter.create({ model: "cloudInvitation", data: invitation("invite-1"), forceAllowId: true });
			const where = [{ field: "tokenDigest", value: invitation("invite-1").tokenDigest }] as const;
			const consumed = await Promise.all([
				adapter.consumeOne({ model: "cloudInvitation", where: [...where] }),
				adapter.consumeOne({ model: "cloudInvitation", where: [...where] }),
			]);
			expect(consumed.filter((value) => value !== null)).toHaveLength(1);
		});
	});

	test("restores a consumed invitation when the surrounding transaction fails", async () => {
		await runFresh(migrateCloudDatabase);
		await withAdapter(async (adapter) => {
			const row = invitation("invite-2");
			await adapter.create({ model: "cloudInvitation", data: row, forceAllowId: true });
			await expect(
				adapter.transaction(async (transaction) => {
					expect(
						await transaction.consumeOne({
							model: "cloudInvitation",
							where: [{ field: "tokenDigest", value: row.tokenDigest }],
						}),
					).not.toBeNull();
					throw new RollbackProbe();
				}),
			).rejects.toBeInstanceOf(RollbackProbe);
			expect(
				await adapter.findOne({
					model: "cloudInvitation",
					where: [{ field: "tokenDigest", value: row.tokenDigest }],
				}),
			).not.toBeNull();
		});
	});

	test("keeps an invitation when the email does not match", async () => {
		await runFresh(migrateCloudDatabase);
		await withAdapter(async (adapter) => {
			const row = invitation("invite-3");
			await adapter.create({ model: "cloudInvitation", data: row, forceAllowId: true });
			expect(
				await adapter.consumeOne({
					model: "cloudInvitation",
					where: [
						{ field: "tokenDigest", value: row.tokenDigest },
						{ field: "email", value: "someone-else@example.com", mode: "insensitive" },
						{ field: "expiresAt", value: DateTime.toDateUtc(DateTime.makeUnsafe(0)), operator: "gt" },
					],
				}),
			).toBeNull();
			expect(
				await adapter.findOne({
					model: "cloudInvitation",
					where: [{ field: "tokenDigest", value: row.tokenDigest }],
				}),
			).not.toBeNull();
		});
	});
});
