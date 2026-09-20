import { DateTime, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test } from "vitest";
import { Dashboard } from "../src/dashboard.ts";
import { Boards } from "../src/boards.ts";
import { Deployments } from "../src/deployments.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { runFresh } from "./fixture.ts";

const create = {
	name: "  Private board  ",
	idempotency_key: "dashboard-create-1",
} as const;

describe("Dashboard", () => {
	test("creates a managed SQLite board idempotently and reports its queued operation", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const first = yield* dashboard.create("user-1", create);
				const replay = yield* dashboard.create("user-1", create);
				expect(replay.id).toBe(first.id);
				expect(first).toMatchObject({
					name: "Private board",
					storage_engine: "sqlite",
					phase: "queued",
					checkpoint: "requested",
					hostname: null,
					region: null,
					volume_size_gb: null,
					last_backup: null,
					error: null,
				});
			}),
		);
	});

	test("scopes list and detail reads to the authenticated owner", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				expect((yield* dashboard.list("user-1")).map(({ id }) => id)).toEqual([board.id]);
				expect(yield* dashboard.list("user-2")).toEqual([]);
				expect(Option.isSome(yield* dashboard.get("user-1", board.id))).toBe(true);
				expect(Option.isNone(yield* dashboard.get("user-2", board.id))).toBe(true);
			}),
		);
	});

	test("rejects blank or oversized friendly names before creating a board", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				for (const name of ["   ", "x".repeat(81)]) {
					const result = yield* Effect.exit(
						dashboard.create("user-1", { name, idempotency_key: `invalid-${name.length}` }),
					);
					expect(Exit.isFailure(result)).toBe(true);
					if (Exit.isFailure(result)) expect(result.cause.toString()).toContain("InvalidBoardName");
				}
				expect(yield* dashboard.list("user-1")).toEqual([]);
			}),
		);
	});

	test("projects persisted operation errors without leaking operation internals", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				const operation = Option.getOrThrow(yield* (yield* Operations).claim("worker-1", 30_000, "provision"));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* (yield* Operations).fail({
					id: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					errorCode: "provider_denied",
					errorMessage: "Fly rejected the request",
				});
				const failed = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(failed).toMatchObject({
					phase: "blocked",
					error: { code: "provider_denied", message: "Fly rejected the request", retrying: false },
				});
				expect(Object.keys(failed)).not.toContain("lease_token");
				expect(Object.keys(failed)).not.toContain("request_hash");
			}),
		);
	});

	test("distinguishes a queued retry from a terminal provisioning failure", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				const operations = yield* Operations;
				const operation = Option.getOrThrow(yield* operations.claim("worker-1", 30_000, "provision"));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* operations.requeue({
					id: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					availableAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
					errorCode: "provider_unavailable",
					errorMessage: "Fly will be retried",
				});
				const retrying = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(retrying).toMatchObject({
					phase: "queued",
					error: { code: "provider_unavailable", message: "Fly will be retried", retrying: true },
				});
				expect(Option.isSome(yield* operations.claim("worker-2", 30_000, "provision"))).toBe(true);
				const running = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(running).toMatchObject({
					phase: "provisioning",
					error: { code: "provider_unavailable", message: "Fly will be retried", retrying: true },
				});
			}),
		);
	});

	test("reports persisted external storage engines without claiming managed SQLite", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const board = yield* (yield* Boards).request({
					owner_id: "user-1",
					name: "Existing external board",
					storage_engine: "postgres",
					requested_by: "user-1",
					idempotency_key: "external-board",
				});
				const external = Option.getOrThrow(yield* (yield* Dashboard).get("user-1", board.id));
				expect(external.storage_engine).toBe("postgres");
			}),
		);
	});

	test("projects provisioned routing, configuration, and the last verified backup", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				const operations = yield* Operations;
				const operation = Option.getOrThrow(yield* operations.claim("worker-1", 30_000, "provision"));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				yield* (yield* Deployments).ensure({
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					spec: {
						hostname: "opaque.boards.chirp.wiki",
						region: "sjc",
						image_ref: `registry.example/chirp@sha256:${"a".repeat(64)}`,
						app_name: "chirp-opaque",
						network_name: "chirp-opaque",
						volume_name: "chirp_data_opaque",
						machine_name: "board-opaque",
						volume_size_gb: 1,
					},
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_deployments SET
					state = 'provisioned', last_snapshot_id = 'snap-1',
					last_snapshot_created_at = '2026-09-20T03:15:00.000Z',
					last_snapshot_digest = 'sha256:verified', last_snapshot_retention_days = 7
					WHERE board_id = ${board.id}`;
				yield* operations.succeed(operation.id, operation.lease_token, "worker-1");
				const ready = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(ready).toMatchObject({
					phase: "ready",
					checkpoint: "provisioned",
					hostname: "opaque.boards.chirp.wiki",
					region: "sjc",
					volume_size_gb: 1,
					last_backup: {
						id: "snap-1",
						created_at: "2026-09-20T03:15:00.000Z",
						digest: "sha256:verified",
						retention_days: 7,
					},
				});
			}),
		);
	});
});
