import * as PgClient from "@effect/sql-pg/PgClient";
import { Config } from "effect";

export const databaseLayer = PgClient.layerConfig({
	url: Config.Redacted("CLOUD_DATABASE_URL"),
	applicationName: Config.succeed("chirp-cloud"),
});
