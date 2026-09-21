import { Effect, Option } from "effect";
import { describe, expect, test, vi } from "vitest";
import { Boards } from "../src/boards.ts";
import { Deployments } from "../src/deployments.ts";
import { FlyApiError } from "../src/fly-board-api.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { PostgresStorage } from "../src/postgres-storage.ts";
import { Provisioner } from "../src/provisioner.ts";
import { deploymentSpec } from "../src/provisioning-settings.ts";
import { runFresh } from "./fixture.ts";
import { appFor, makeFakeProvider, nextClaim, provisionerFor, request, settings } from "./fixtures/provisioner.ts";

describe("readable slug provider ownership", () => {
	test("refuses an existing matching App before staging PostgreSQL secrets or mutating Fly", async () => {
		const provider = makeFakeProvider();
		const stage = vi.fn(() => Effect.succeed(1));
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request({ ...request, slug: "quiet-robin", storage_engine: "postgres" });
				provider.set.app(appFor(board.slug));
				const operation = yield* nextClaim("worker");
				if (!operation.lease_token) return yield* Effect.die("Missing lease");
				const lease = { operationId: operation.id, leaseToken: operation.lease_token, workerId: "worker" };
				const deployments = yield* Deployments;
				const deployment = yield* deployments.ensure({ ...lease, spec: deploymentSpec(board.slug, settings) });
				yield* deployments.transition({
					...lease,
					expectedCheckpoint: "requested",
					expectedRowVersion: deployment.row_version,
					next: "storage_configuration_verified",
				});
				expect(yield* (yield* Provisioner).run(operation, "worker")).toBe("blocked");
				expect(stage).not.toHaveBeenCalled();
				expect(provider.calls).toEqual({ createApp: 0, createVolume: 0, createMachine: 0, startMachine: 0 });
				expect(Option.getOrThrow(yield* deployments.get(board.id)).app_id).toBeNull();
			}).pipe(
				Effect.provide(provisionerFor(provider)),
				Effect.provideService(PostgresStorage, {
					prepare: () => Effect.succeed(undefined),
					stage,
					assertReady: () => Effect.succeed(1),
				}),
			),
		);
	});
	test("reconciles its own durably marked ambiguous creation without duplicating the App", async () => {
		const provider = makeFakeProvider();
		provider.set.hideAppAfterCreate();
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request({ ...request, slug: "gentle-wren" });
				const provisioner = yield* Provisioner;
				expect(yield* provisioner.run(yield* nextClaim("first"), "first")).toBe("requeued");
				const retry = yield* nextClaim("second");
				expect(retry.ambiguous_mutations).toContain("app_create");
				expect(yield* provisioner.run(retry, "second")).toBe("succeeded");
				expect(provider.calls.createApp).toBe(1);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});
	test("does not adopt an App that races creation and causes a definitive conflict", async () => {
		const provider = makeFakeProvider();
		provider.fake.createApp = (input) => {
			provider.set.app(appFor(input.name.replace(/^chirp-/, "")));
			return Effect.fail(new FlyApiError({ operation: "create_app", reason: "status", status: 409 }));
		};
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request({ ...request, slug: "bright-finch" });
				expect(yield* (yield* Provisioner).run(yield* nextClaim("worker"), "worker")).toBe("blocked");
				expect(provider.calls.createVolume).toBe(0);
				expect(provider.calls.createMachine).toBe(0);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});
});
