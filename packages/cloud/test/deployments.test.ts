import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { DeploymentDrift } from "../src/deployment.ts";
import { Deployments } from "../src/deployments.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { boardOperations, boardRoutes } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";

const request = {
	owner_id: "user-1",
	name: "Managed board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-fly-1",
} as const;

const spec = {
	hostname: "0123456789abcdef0123456789abcdef.boards.chirp.wiki",
	region: "sjc",
	image_ref: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	app_name: "chirp-0123456789abcdef0123456789abcdef",
	network_name: "chirp-0123456789abcdef0123456789abcdef",
	volume_name: "chirp_data_0123456789abcdef0123456789abcdef",
	machine_name: "board-0123456789abcdef0123456789abcdef",
	volume_size_gb: 1,
} as const;

describe("Deployments", () => {
	test("creates immutable deployment intent and advances it with the operation checkpoint", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const deployments = yield* Deployments;
				const lease = {
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
				};
				const created = yield* deployments.ensure({ ...lease, spec });
				expect(created).toMatchObject({
					board_id: board.id,
					state: "requested",
					storage_engine: "sqlite",
					row_version: 0,
				});
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							deployments.transition({
								...lease,
								expectedCheckpoint: "requested",
								expectedRowVersion: 0,
								next: "app_created",
							}),
						),
					),
				).toBe(true);
				const advanced = yield* deployments.transition({
					...lease,
					expectedCheckpoint: "requested",
					expectedRowVersion: 0,
					next: "storage_configuration_verified",
				});
				expect(advanced.row_version).toBe(1);
				const db = yield* Database;
				expect(
					yield* db
						.select({ checkpoint: boardOperations.checkpoint })
						.from(boardOperations)
						.where(eq(boardOperations.id, operation.id)),
				).toEqual([{ checkpoint: "storage_configuration_verified" }]);
			}),
		);
	});

	test("rejects immutable spec drift and stale row versions", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const deployments = yield* Deployments;
				const lease = {
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
				};
				yield* deployments.ensure({ ...lease, spec });
				const existing = yield* deployments.ensure({
					...lease,
					spec: {
						...spec,
						image_ref: `registry.example/chirp@sha256:${"b".repeat(64)}`,
						volume_name: "new-default-volume-name",
						volume_size_gb: 20,
					},
				});
				expect(existing).toMatchObject({
					image_ref: spec.image_ref,
					volume_name: spec.volume_name,
					volume_size_gb: spec.volume_size_gb,
				});
				const drift = yield* Effect.exit(deployments.ensure({ ...lease, spec: { ...spec, region: "iad" } }));
				expect(Exit.isFailure(drift)).toBe(true);
				if (Exit.isFailure(drift)) expect(drift.cause.toString()).toContain(DeploymentDrift.name);
				yield* deployments.transition({
					...lease,
					expectedCheckpoint: "requested",
					expectedRowVersion: 0,
					next: "storage_configuration_verified",
				});
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							deployments.transition({
								...lease,
								expectedCheckpoint: "storage_configuration_verified",
								expectedRowVersion: 0,
								next: "app_created",
							}),
						),
					),
				).toBe(true);
			}),
		);
	});

	test("publishes a route only behind the active lease at machine_started", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				yield* (yield* Boards).request(request);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const deployments = yield* Deployments;
				const lease = {
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
				};
				let deployment = yield* deployments.ensure({ ...lease, spec });
				for (const next of [
					"storage_configuration_verified",
					"app_created",
					"volume_created",
					"machine_created",
					"machine_started",
				] as const) {
					deployment = yield* deployments.transition({
						...lease,
						expectedCheckpoint: deployment.state,
						expectedRowVersion: deployment.row_version,
						next,
					});
				}
				yield* deployments.publishRoute({ ...lease, expectedRowVersion: deployment.row_version });
				const db = yield* Database;
				expect(
					yield* db.select({ hostname: boardRoutes.hostname, app_name: boardRoutes.app_name }).from(boardRoutes),
				).toEqual([{ hostname: spec.hostname, app_name: spec.app_name }]);
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							deployments.publishRoute({
								...lease,
								leaseToken: "00000000-0000-4000-8000-000000000000",
								expectedRowVersion: deployment.row_version,
							}),
						),
					),
				).toBe(true);
			}),
		);
	});
});
