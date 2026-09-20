import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer } from "effect";
import { databaseLayer } from "./database.ts";
import { retryBlockedDeployment } from "./deployment-recovery.ts";

Effect.gen(function* () {
	const failedOperationId = yield* Config.String("FAILED_OPERATION_ID");
	const expectedRowVersion = yield* Config.Int("EXPECTED_DEPLOYMENT_ROW_VERSION");
	const operationId = yield* retryBlockedDeployment({ failedOperationId, expectedRowVersion });
	yield* Console.log(`Provisioning retry operation: ${operationId}`);
}).pipe(Effect.provide(Layer.merge(databaseLayer, NodeServices.layer)), NodeRuntime.runMain);
