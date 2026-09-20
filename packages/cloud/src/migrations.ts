import { asc, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Database, type DatabaseClient } from "./database.ts";
import { CloudMigrationError, type MigrationMetadata, validateMigrationLedger } from "./migration-ledger.ts";
import * as foundation from "./migrations/0001_foundation.ts";
import * as cloudAuth from "./migrations/0002_cloud_auth.ts";
import * as flyProvisioning from "./migrations/0003_fly_provisioning.ts";
import * as provisioningRecovery from "./migrations/0004_provisioning_recovery.ts";
import * as providerMutationMarkers from "./migrations/0005_provider_mutation_markers.ts";
import { cloudMigrations } from "./schema.ts";

export { CloudMigrationError } from "./migration-ledger.ts";

interface Migration extends MigrationMetadata {
	readonly effect: (database: DatabaseClient) => Effect.Effect<unknown, EffectDrizzleQueryError | SqlError>;
}

const migrations: ReadonlyArray<Migration> = [
	foundation,
	cloudAuth,
	flyProvisioning,
	provisioningRecovery,
	providerMutationMarkers,
];
const receipts = Schema.decodeUnknownEffect(
	Schema.Array(
		Schema.Struct({ id: Schema.Int, name: Schema.String, compatibleSchemaVersions: Schema.Array(Schema.Int) }),
	),
);

export const runCloudMigrations = (registry: ReadonlyArray<Migration>) =>
	Effect.gen(function* () {
		yield* validateMigrationLedger(registry, []);
		const database = yield* Database;
		yield* database.transaction((transaction) =>
			Effect.gen(function* () {
				yield* transaction.execute(sql`SELECT pg_advisory_xact_lock(485017403101)`);
				yield* transaction.execute(sql`CREATE TABLE IF NOT EXISTS cloud_migrations (
					migration_id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					compatible_schema_versions INTEGER[] NOT NULL DEFAULT '{}',
					created_at TIMESTAMPTZ NOT NULL DEFAULT now()
				)`);
				const applied = yield* transaction
					.select({
						id: cloudMigrations.migration_id,
						name: cloudMigrations.name,
						compatibleSchemaVersions: cloudMigrations.compatible_schema_versions,
					})
					.from(cloudMigrations)
					.orderBy(asc(cloudMigrations.migration_id))
					.pipe(
						Effect.flatMap(receipts),
						Effect.mapError(
							() =>
								new CloudMigrationError({
									message: `Cloud schema ${registry.at(-1)?.id ?? 0}: migration ledger is unreadable; schema readiness cannot be verified`,
								}),
						),
					);
				yield* validateMigrationLedger(registry, applied);
				for (const migration of registry.slice(applied.length)) {
					yield* migration.effect(transaction);
					yield* transaction.insert(cloudMigrations).values({
						migration_id: migration.id,
						name: migration.name,
						compatible_schema_versions: [...migration.compatibleSchemaVersions],
					});
				}
			}),
		);
	});

export const migrateCloudDatabase = runCloudMigrations(migrations);
