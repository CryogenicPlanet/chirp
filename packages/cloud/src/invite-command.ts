import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { databaseLayer } from "./database.ts";
import { Invitations, invitationsLayer } from "./invitations.ts";
import { migrateCloudDatabase } from "./migrations.ts";

const layer = invitationsLayer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(NodeServices.layer));

Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const issued = yield* Invitations.use((invitations) => invitations.issue(null, 24 * 60 * 60 * 1_000));
	yield* Console.log(`Invitation: /invite#${issued.token}`);
}).pipe(Effect.provide(layer), NodeRuntime.runMain);
