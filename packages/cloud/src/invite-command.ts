import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer } from "effect";
import { databaseLayer } from "./database.ts";
import { Invitations, invitationsLayer } from "./invitations.ts";
import { migrateCloudDatabase } from "./migrations.ts";

const layer = invitationsLayer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(NodeServices.layer));

Effect.gen(function* () {
	yield* migrateCloudDatabase;
	const email = yield* Config.String("INVITATION_EMAIL");
	const issued = yield* Invitations.use((invitations) => invitations.issue(email, 24 * 60 * 60 * 1_000));
	yield* Console.log(`Invitation for ${issued.invitation.email}: /invite#${issued.token}`);
}).pipe(Effect.provide(layer), NodeRuntime.runMain);
