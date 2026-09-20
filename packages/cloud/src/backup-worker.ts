import { Context, Effect, Layer, Option } from "effect";
import { BackupObserver } from "./backup-observer.ts";
import { Operations } from "./operations.ts";

const make = Effect.gen(function* () {
	const operations = yield* Operations;
	const observer = yield* BackupObserver;
	return {
		runOnce: (workerId: string) =>
			operations.claim(workerId, 90_000, "backup").pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (operation) => observer.run(operation, workerId).pipe(Effect.asSome),
					}),
				),
			),
	};
});

export class BackupWorker extends Context.Service<BackupWorker, Effect.Success<typeof make>>()(
	"comms/cloud/BackupWorker",
) {}
export const backupWorkerLayer = Layer.effect(BackupWorker, make);
