import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Config, Context, Layer } from "effect";

export type DatabaseClient = PgDrizzle.EffectPgDatabase;

export class Database extends Context.Service<Database, DatabaseClient>()("comms/cloud/Database") {}

export const drizzleLayer = Layer.effect(Database, PgDrizzle.makeWithDefaults());

const postgresLayer = PgClient.layerConfig({
	url: Config.Redacted("CLOUD_DATABASE_URL"),
	applicationName: Config.succeed("chirp-cloud"),
	maxConnections: Config.succeed(8),
	multiplex: Config.succeed(false),
});

export const databaseLayer = drizzleLayer.pipe(Layer.provideMerge(postgresLayer));
