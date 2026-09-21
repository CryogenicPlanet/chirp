import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { databaseLayer, type DatabaseClient } from "../../src/database.ts";
import { runCloudMigrations } from "../../src/migrations.ts";
import * as foundation from "../../src/migrations/0001_foundation.ts";

const mode = process.argv[2];
const upgrade = {
	id: 2,
	name: "additive",
	compatibleSchemaVersions: mode === "incompatible" ? [] : [1],
	effect: (database: DatabaseClient) =>
		Effect.gen(function* () {
			yield* database.execute(sql`ALTER TABLE boards ADD COLUMN description TEXT`);
			if (mode === "crash") {
				process.stdout.write("uncommitted-ddl\n");
				return yield* Effect.never;
			}
		}),
};

await Effect.runPromise(
	runCloudMigrations(mode === "older" ? [foundation] : [foundation, upgrade]).pipe(
		Effect.provide(databaseLayer),
		Effect.match({
			onFailure: (error) => {
				process.stderr.write(error._tag === "CloudMigrationError" ? `${error.message}\n` : "Migration failed\n");
				process.exitCode = 1;
			},
			onSuccess: () => process.stdout.write("schema-ready\n"),
		}),
	),
);
