import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Option, Schema } from "effect";
import { databaseLayer } from "./database.ts";
import { retryBlockedDeployment } from "./deployment-recovery.ts";
import { ProviderMutation } from "./operation.ts";

Effect.gen(function* () {
	const failedOperationId = yield* Config.String("FAILED_OPERATION_ID");
	const expectedRowVersion = yield* Config.Int("EXPECTED_DEPLOYMENT_ROW_VERSION");
	const configuredMutations = yield* Config.option(Config.String("CONFIRMED_ABSENT_MUTATIONS"));
	const confirmedAbsentMutations = yield* Schema.decodeUnknownEffect(Schema.Array(ProviderMutation))(
		Option.match(configuredMutations, {
			onNone: () => [],
			onSome: (value) =>
				value
					.split(",")
					.map((mutation) => mutation.trim())
					.filter((mutation) => mutation.length > 0),
		}),
	);
	const operationId = yield* retryBlockedDeployment({
		failedOperationId,
		expectedRowVersion,
		confirmedAbsentMutations,
	});
	yield* Console.log(`Provisioning retry operation: ${operationId}`);
}).pipe(Effect.provide(Layer.merge(databaseLayer, NodeServices.layer)), NodeRuntime.runMain);
