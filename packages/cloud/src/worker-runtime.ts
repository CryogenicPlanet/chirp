import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BackupObserver, backupObserverLayer } from "./backup-observer.ts";
import { BackupScheduler, backupSchedulerLayer } from "./backup-scheduler.ts";
import { BackupWorker, backupWorkerLayer } from "./backup-worker.ts";
import { Boards, boardsLayer } from "./boards.ts";
import { databaseLayer } from "./database.ts";
import { Deployments, deploymentsLayer } from "./deployments.ts";
import { edgeProbeLayer } from "./edge-probe.ts";
import { flyBoardApiLayer } from "./fly-board-api.ts";
import { Operations, operationsLayer } from "./operations.ts";
import { Provisioner, provisionerLayer } from "./provisioner.ts";
import { provisioningSettings } from "./provisioning-settings.ts";
import { ProvisioningWorker, provisioningWorkerLayer } from "./provisioning-worker.ts";

const workerLayer = Layer.unwrap(
	Effect.all({ flyToken: Config.Redacted("FLY_API_TOKEN"), provisioning: provisioningSettings }).pipe(
		Effect.map(({ flyToken, provisioning }) => {
			const stores = Layer.mergeAll(boardsLayer, deploymentsLayer, operationsLayer).pipe(
				Layer.provideMerge(databaseLayer),
				Layer.provideMerge(NodeServices.layer),
			);
			const providers = Layer.mergeAll(
				flyBoardApiLayer({ token: flyToken }).pipe(Layer.provide(FetchHttpClient.layer)),
				edgeProbeLayer.pipe(Layer.provide(FetchHttpClient.layer)),
			);
			const reconcilers = Layer.mergeAll(
				provisionerLayer(provisioning),
				backupObserverLayer,
				backupSchedulerLayer,
			).pipe(Layer.provideMerge(stores), Layer.provideMerge(providers));
			return Layer.mergeAll(provisioningWorkerLayer, backupWorkerLayer).pipe(Layer.provideMerge(reconcilers));
		}),
	),
);

const loop = Effect.gen(function* () {
	const provisioning = yield* ProvisioningWorker;
	const scheduler = yield* BackupScheduler;
	const backups = yield* BackupWorker;
	return yield* Effect.gen(function* () {
		const provisioned = yield* provisioning.runOnce("chirp-cloud-provisioner");
		yield* scheduler.scheduleDue;
		const observed = yield* backups.runOnce("chirp-cloud-backup-observer");
		if (Option.isNone(provisioned) && Option.isNone(observed)) yield* Effect.sleep("1 second");
	}).pipe(
		Effect.catchCause((cause) => Effect.logError("Chirp Cloud worker iteration failed", cause)),
		Effect.forever,
	);
});

export interface WorkerRuntime {
	readonly dispose: () => Promise<void>;
}

export const startWorkerRuntime = (): Promise<WorkerRuntime> => {
	const runtime = ManagedRuntime.make(workerLayer);
	return runtime
		.runPromise(
			Effect.all(
				[
					Boards,
					Deployments,
					Operations,
					Provisioner,
					BackupObserver,
					BackupScheduler,
					ProvisioningWorker,
					BackupWorker,
				],
				{ discard: true },
			),
		)
		.then(() => {
			const fiber = runtime.runFork(loop);
			return {
				dispose: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => runtime.dispose()),
			};
		})
		.catch((error: unknown) => runtime.dispose().then(() => Promise.reject(error)));
};
