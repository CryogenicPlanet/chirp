import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { databaseLayer } from "./database.ts";
import { migrateCloudDatabase } from "./migrations.ts";

migrateCloudDatabase.pipe(Effect.provide(databaseLayer), NodeRuntime.runMain);
