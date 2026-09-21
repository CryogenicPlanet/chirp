import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { retryBlockedDeployment } from "../src/deployment-recovery.ts";
import { Deployments } from "../src/deployments.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { Provisioner } from "../src/provisioner.ts";
import { realPostgres, runFresh } from "./fixture.ts";
import { makeFakeProvider, nextClaim, provisionerFor, request, settings } from "./fixtures/provisioner.ts";

const prepare = (provider: ReturnType<typeof makeFakeProvider>) =>
	Effect.gen(function* () {
		yield* migrateCloudDatabase;
		const board = yield* (yield* Boards).request(request);
		provider.set.failHealth();
		const first = yield* nextClaim("worker");
		expect(yield* (yield* Provisioner).run(first, "worker")).toBe("requeued");
		const failed = yield* nextClaim("worker");
		if (!failed.lease_token) return yield* Effect.die("Missing lease");
		yield* (yield* Operations).markAmbiguousMutation({
			id: failed.id,
			leaseToken: failed.lease_token,
			workerId: "worker",
			mutation: "edge_a_record",
		});
		const lease = { operationId: failed.id, leaseToken: failed.lease_token, workerId: "worker" };
		const deployment = yield* (yield* Deployments).block({
			...lease,
			errorCode: "provider_drift",
			errorMessage: "Operator repair required",
		});
		return {
			board,
			failed,
			lease,
			deployment,
			input: { failedOperationId: failed.id, expectedRowVersion: deployment.row_version },
		};
	});

describe("deployment recovery", () => {
	test("resumes one idempotent retry with recorded IDs, checkpoint, failure history, and snapshots intact", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				const { board, failed, input, lease, deployment } = yield* prepare(provider);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_deployments SET last_snapshot_id = 'snapshot-id', last_snapshot_digest = 'digest',
				last_snapshot_created_at = clock_timestamp(), last_snapshot_retention_days = 5 WHERE board_id = ${board.id}`;
				const id = yield* retryBlockedDeployment(input);
				expect(yield* retryBlockedDeployment(input)).toBe(id);
				expect(id).not.toBe(failed.id);
				const retry = yield* nextClaim("recovery-worker");
				expect(retry).toMatchObject({
					id,
					checkpoint: "machine_started",
					attempt: 1,
					ambiguous_mutations: ["edge_a_record"],
				});
				expect(
					Exit.isFailure(
						yield* Effect.exit((yield* Deployments).block({ ...lease, errorCode: "stale", errorMessage: "stale" })),
					),
				).toBe(true);
				expect(yield* (yield* Provisioner).run(retry, "recovery-worker")).toBe("succeeded");
				expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id))).toMatchObject({
					state: "provisioned",
					app_id: deployment.app_id,
					volume_id: deployment.volume_id,
					machine_id: deployment.machine_id,
					last_snapshot_id: "snapshot-id",
					last_snapshot_digest: "digest",
					last_snapshot_retention_days: 5,
				});
				expect(yield* retryBlockedDeployment(input)).toBe(id);
				expect(
					yield* sql`SELECT state, last_error_code, checkpoint, attempt FROM board_operations WHERE id = ${failed.id}`,
				).toEqual([{ state: "failed", last_error_code: "provider_drift", checkpoint: "machine_started", attempt: 2 }]);
				expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("clears only provider mutations explicitly confirmed absent by the operator", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				const { input } = yield* prepare(provider);
				expect(
					Exit.isFailure(
						yield* Effect.exit(retryBlockedDeployment({ ...input, confirmedAbsentMutations: ["volume_create"] })),
					),
				).toBe(true);
				const resolved = { ...input, confirmedAbsentMutations: ["edge_a_record"] as const };
				const id = yield* retryBlockedDeployment(resolved);
				expect(yield* retryBlockedDeployment(resolved)).toBe(id);
				expect(Exit.isFailure(yield* Effect.exit(retryBlockedDeployment(input)))).toBe(true);
				const retry = yield* nextClaim("recovery-worker");
				expect(retry).toMatchObject({ id, ambiguous_mutations: [] });
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test.each(["missing-volume", "configuration"])(
		"refuses unresolved %s drift without recreating resources",
		async (drift) => {
			const provider = makeFakeProvider();
			await runFresh(
				Effect.gen(function* () {
					const { board, input } = yield* prepare(provider).pipe(Effect.provide(provisionerFor(provider)));
					const id = yield* retryBlockedDeployment(input);
					if (drift === "missing-volume") provider.set.hideVolumes();
					const operation = yield* nextClaim("recovery-worker");
					expect(yield* (yield* Provisioner).run(operation, "recovery-worker")).toBe("blocked");
					expect(yield* retryBlockedDeployment(input)).toBe(id);
					const deployment = Option.getOrThrow(yield* (yield* Deployments).get(board.id));
					expect(deployment).toMatchObject({
						state: "blocked",
						volume_id: "volume-id",
						machine_id: "machine-id",
						region: settings.region,
					});
					expect(provider.calls).toMatchObject({ createApp: 1, createVolume: 1, createMachine: 1 });
					expect(
						yield* retryBlockedDeployment({
							failedOperationId: operation.id,
							expectedRowVersion: deployment.row_version,
						}),
					).not.toBe(id);
				}).pipe(
					Effect.provide(
						provisionerFor(provider, drift === "configuration" ? { ...settings, region: "iad" } : settings),
					),
				),
			);
		},
	);

	test("refuses stale approval, active work, and ordinary provision requests without changing deployment state", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				const { board, input, deployment } = yield* prepare(provider);
				const operations = yield* Operations;
				expect(
					Exit.isFailure(
						yield* Effect.exit(retryBlockedDeployment({ ...input, expectedRowVersion: input.expectedRowVersion - 1 })),
					),
				).toBe(true);
				expect(
					Exit.isFailure(
						yield* Effect.exit(
							operations.enqueue({
								board_id: board.id,
								owner_id: board.owner_id,
								kind: "provision",
								requested_by: "operator",
								idempotency_key: "unsafe-reprovision",
							}),
						),
					),
				).toBe(true);
				yield* operations.enqueue({
					board_id: board.id,
					owner_id: board.owner_id,
					kind: "backup",
					requested_by: "operator",
					idempotency_key: "active-backup",
				});
				expect(Exit.isFailure(yield* Effect.exit(retryBlockedDeployment(input)))).toBe(true);
				expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id))).toEqual(deployment);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test("rolls back the retry operation when resetting the deployment fails", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				const { board, input } = yield* prepare(provider);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`ALTER TABLE board_deployments ADD CONSTRAINT reject_retry CHECK (state = 'blocked')`;
				expect(Exit.isFailure(yield* Effect.exit(retryBlockedDeployment(input)))).toBe(true);
				expect(yield* sql`SELECT id FROM board_operations WHERE requested_by = 'operator:deployment-retry'`).toEqual(
					[],
				);
				expect(Option.getOrThrow(yield* (yield* Deployments).get(board.id)).state).toBe("blocked");
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});

	test.skipIf(!realPostgres)("serializes concurrent operator retries into one operation", async () => {
		const provider = makeFakeProvider();
		await runFresh(
			Effect.gen(function* () {
				const { input } = yield* prepare(provider);
				const ids = yield* Effect.all([retryBlockedDeployment(input), retryBlockedDeployment(input)], {
					concurrency: "unbounded",
				});
				expect(ids[0]).toBe(ids[1]);
			}).pipe(Effect.provide(provisionerFor(provider))),
		);
	});
});
