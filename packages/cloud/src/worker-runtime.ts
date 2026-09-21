import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BackupObserver, backupObserverLayer } from "./backup-observer.ts";
import { BackupScheduler, backupSchedulerLayer } from "./backup-scheduler.ts";
import { BoardDeletionWorker, boardDeletionWorkerLayer } from "./board-deletion-worker.ts";
import { flyDeletionApiLayer } from "./fly-deletion-api.ts";
import { Boards, boardsLayer } from "./boards.ts";
import { cloudflareDnsLayer, cloudflareSettings } from "./cloudflare-dns.ts";
import { cloudSecretsLayer } from "./cloud-secrets.ts";
import { flySecretsLayer } from "./fly-secrets.ts";
import { postgresStorageLayer } from "./postgres-storage.ts";
import { databaseLayer } from "./database.ts";
import { Deployments, deploymentsLayer } from "./deployments.ts";
import { edgeProbeLayer } from "./edge-probe.ts";
import { imageRegistryLayer, imageRepositorySetting, parseImageRepository } from "./image-registry.ts";
import { flyBoardApiLayer } from "./fly-board-api.ts";
import { Operations, operationsLayer } from "./operations.ts";
import { Provisioner, provisionerLayer } from "./provisioner.ts";
import { provisioningSettings } from "./provisioning-settings.ts";

const workerLayer = Layer.unwrap(
	Effect.all({
		flyToken: Config.Redacted("FLY_API_TOKEN"),
		provisioning: provisioningSettings,
		cloudflare: cloudflareSettings,
		repository: imageRepositorySetting.pipe(Effect.flatMap(parseImageRepository)),
	}).pipe(
		Effect.map(({ flyToken, provisioning, cloudflare, repository }) => {
			const stores = Layer.mergeAll(boardsLayer, deploymentsLayer, operationsLayer, postgresStorageLayer).pipe(
				Layer.provideMerge(databaseLayer),
				Layer.provideMerge(cloudSecretsLayer),
				Layer.provideMerge(NodeServices.layer),
			);
			const providers = Layer.mergeAll(
				flySecretsLayer({ token: flyToken }).pipe(Layer.provide(FetchHttpClient.layer)),
				flyDeletionApiLayer({ token: flyToken }).pipe(Layer.provide(FetchHttpClient.layer)),
				cloudflareDnsLayer(cloudflare).pipe(Layer.provide(FetchHttpClient.layer)),
				flyBoardApiLayer({ token: flyToken }).pipe(Layer.provide(FetchHttpClient.layer)),
				edgeProbeLayer.pipe(Layer.provide(FetchHttpClient.layer)),
				imageRegistryLayer(repository).pipe(Layer.provide(FetchHttpClient.layer)),
			);
			return Layer.mergeAll(
				provisionerLayer(provisioning),
				boardDeletionWorkerLayer(provisioning),
				backupObserverLayer,
				backupSchedulerLayer,
			).pipe(Layer.provideMerge(stores), Layer.provideMerge(providers));
		}),
	),
);

const loop = Effect.gen(function* () {
	const operations = yield* Operations;
	const provisioner = yield* Provisioner;
	const scheduler = yield* BackupScheduler;
	const observer = yield* BackupObserver;
	const deletion = yield* BoardDeletionWorker;
	return yield* Effect.gen(function* () {
		const deleted = yield* operations.claim("chirp-cloud-deletion", 90_000, "delete").pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeedNone,
					onSome: (operation) => deletion.run(operation, "chirp-cloud-deletion").pipe(Effect.asSome),
				}),
			),
		);
		const provisioned = yield* operations.claim("chirp-cloud-provisioner", 90_000, "provision").pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeedNone,
					onSome: (operation) => provisioner.run(operation, "chirp-cloud-provisioner").pipe(Effect.asSome),
				}),
			),
		);
		yield* scheduler.scheduleDue;
		const observed = yield* operations.claim("chirp-cloud-backup-observer", 90_000, "backup").pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.succeedNone,
					onSome: (operation) => observer.run(operation, "chirp-cloud-backup-observer").pipe(Effect.asSome),
				}),
			),
		);
		if (Option.isNone(deleted) && Option.isNone(provisioned) && Option.isNone(observed))
			yield* Effect.sleep("1 second");
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("Chirp Cloud worker iteration failed", cause).pipe(Effect.andThen(Effect.sleep("1 second"))),
		),
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
			Effect.all([Boards, Deployments, Operations, Provisioner, BackupObserver, BackupScheduler], { discard: true }),
		)
		.then(() => {
			const fiber = runtime.runFork(loop);
			return {
				dispose: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => runtime.dispose()),
			};
		})
		.catch((error: unknown) => runtime.dispose().then(() => Promise.reject(error)));
};
