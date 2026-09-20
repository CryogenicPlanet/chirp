import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as foundation from "./migrations/0001_foundation.ts";

interface Migration {
	readonly id: number;
	readonly name: string;
	readonly effect: Effect.Effect<unknown, SqlError, SqlClient.SqlClient>;
}

const migrations: ReadonlyArray<Migration> = [foundation];
const receipts = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
);

export class CloudMigrationError extends Data.TaggedError("CloudMigrationError")<{
	readonly message: string;
}> {}

export const migrateCloudDatabase = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`SELECT pg_advisory_xact_lock(485017403101)`;
			yield* sql`CREATE TABLE IF NOT EXISTS cloud_migrations (
				migration_id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`;
			const applied = yield* sql`SELECT migration_id, name FROM cloud_migrations ORDER BY migration_id`.pipe(
				Effect.flatMap(receipts),
			);
			for (let index = 0; index < applied.length; index += 1) {
				const receipt = applied[index];
				const expected = migrations[index];
				if (!receipt || !expected || receipt.migration_id !== expected.id || receipt.name !== expected.name)
					return yield* new CloudMigrationError({
						message: "Cloud migration ledger does not match the static registry",
					});
			}
			for (const migration of migrations.slice(applied.length)) {
				yield* migration.effect;
				yield* sql`INSERT INTO cloud_migrations (migration_id, name) VALUES (${migration.id}, ${migration.name})`;
			}
		}),
	);
});
