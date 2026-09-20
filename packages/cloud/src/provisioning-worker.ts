import { Context, Effect, Layer, Option } from "effect";
import { Operations } from "./operations.ts";
import { Provisioner } from "./provisioner.ts";

const make = Effect.gen(function* () {
	const operations = yield* Operations;
	const provisioner = yield* Provisioner;
	return {
		runOnce: (workerId: string) =>
			operations.claim(workerId, 90_000, "provision").pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (operation) => provisioner.run(operation, workerId).pipe(Effect.asSome),
					}),
				),
			),
	};
});

export class ProvisioningWorker extends Context.Service<ProvisioningWorker, Effect.Success<typeof make>>()(
	"comms/cloud/ProvisioningWorker",
) {}
export const provisioningWorkerLayer = Layer.effect(ProvisioningWorker, make);
