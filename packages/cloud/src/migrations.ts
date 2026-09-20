import { Data, Effect, Schema } from "effect";
import { asc, sql } from "drizzle-orm";
import { Database } from "./database.ts";
import * as foundation from "./migrations/0001_foundation.ts";
import { cloudMigrations } from "./schema.ts";

interface Migration {
	readonly id: number;
	readonly name: string;
	readonly effect: typeof foundation.effect;
}

const migrations: ReadonlyArray<Migration> = [foundation];
const receipts = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
);

export class CloudMigrationError extends Data.TaggedError("CloudMigrationError")<{
	readonly message: string;
}> {}

export const migrateCloudDatabase = Effect.gen(function* () {
	const database = yield* Database;
	yield* database.transaction((transaction) =>
		Effect.gen(function* () {
			yield* transaction.execute(sql`SELECT pg_advisory_xact_lock(485017403101)`);
			yield* transaction.execute(sql`CREATE TABLE IF NOT EXISTS cloud_migrations (
				migration_id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
			const applied = yield* transaction
				.select({ migration_id: cloudMigrations.migration_id, name: cloudMigrations.name })
				.from(cloudMigrations)
				.orderBy(asc(cloudMigrations.migration_id))
				.pipe(Effect.flatMap(receipts));
			for (let index = 0; index < applied.length; index += 1) {
				const receipt = applied[index];
				const expected = migrations[index];
				if (!receipt || !expected || receipt.migration_id !== expected.id || receipt.name !== expected.name)
					return yield* new CloudMigrationError({
						message: "Cloud migration ledger does not match the static registry",
					});
			}
			for (const migration of migrations.slice(applied.length)) {
				yield* migration.effect(transaction);
				yield* transaction.insert(cloudMigrations).values({
					migration_id: migration.id,
					name: migration.name,
				});
			}
		}),
	);
});
