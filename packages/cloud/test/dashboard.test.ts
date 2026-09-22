import { DateTime, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, test, vi } from "vitest";
import { Dashboard } from "../src/dashboard.ts";
import { Boards, maxListedBoardsPerOwner } from "../src/boards.ts";
import { Deployments } from "../src/deployments.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { Operations } from "../src/operations.ts";
import { runFresh } from "./fixture.ts";
import { deploymentSpec } from "../src/provisioning-settings.ts";
import { imageRef, settings } from "./fixtures/provisioner.ts";

const sqlRequeue = (boardId: string, code: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE board_operations SET last_error_code = ${code} WHERE board_id = ${boardId} AND kind = 'provision'`;
	});

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
				expect((yield* dashboard.list("user-1")).boards.map(({ id }) => id)).toEqual([board.id]);
				expect(yield* dashboard.list("user-2")).toEqual({
					boards: [],
					truncated: false,
					capabilities: { postgres: false },
					boards_domain: "boards.chirp.wiki",
				});
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
				expect(yield* dashboard.list("user-1")).toEqual({
					boards: [],
					truncated: false,
					capabilities: { postgres: false },
					boards_domain: "boards.chirp.wiki",
				});
			}),
		);
	});

	test("bounds the listing independently from the create quota and reports truncation", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO boards (id, owner_id, name, slug, storage_engine)
				SELECT ('01956d31-c55b-7a01-9088-' || lpad(i::text, 12, '0'))::uuid,
					'user-1', 'Board ' || i::text, lpad(i::text, 32, '0'), 'sqlite'
				FROM generate_series(1, ${maxListedBoardsPerOwner + 1}) i`;
				const deployments = yield* Deployments;
				const operations = yield* Operations;
				const get = vi.spyOn(deployments, "get");
				const latest = vi.spyOn(operations, "latest");
				const listed = yield* (yield* Dashboard).list("user-1");
				expect(listed.boards).toHaveLength(maxListedBoardsPerOwner);
				expect(listed.boards[0]?.name).toBe(`Board ${maxListedBoardsPerOwner + 1}`);
				expect(listed.truncated).toBe(true);
				expect(get).not.toHaveBeenCalled();
				expect(latest).not.toHaveBeenCalled();
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
				const stored = Option.getOrThrow(yield* (yield* Boards).get("user-1", board.id));
				yield* (yield* Deployments).ensure({
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					spec: deploymentSpec(stored.slug, imageRef, settings),
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_deployments SET state = 'blocked' WHERE board_id = ${board.id}`;
				yield* sql`UPDATE board_operations SET checkpoint = 'volume_created' WHERE id = ${operation.id}`;
				yield* (yield* Operations).fail({
					id: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					errorCode: "provider_denied",
					errorMessage: "Fly rejected the request",
				});
				yield* (yield* Operations).enqueue({
					board_id: board.id,
					owner_id: "user-1",
					requested_by: "user-1",
					kind: "backup",
					idempotency_key: "later-backup",
				});
				const failed = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(failed).toMatchObject({
					phase: "blocked",
					checkpoint: "volume_created",
					operation: { id: operation.id, state: "failed", attempt: 1, next_attempt_at: null },
					error: { code: "provider_denied", message: "Fly rejected the request", retrying: false },
				});
				expect(Object.keys(failed)).not.toContain("lease_token");
				expect(Object.keys(failed)).not.toContain("request_hash");
				expect(yield* dashboard.list("user-1")).toEqual({
					boards: [failed],
					truncated: false,
					capabilities: { postgres: false },
					boards_domain: "boards.chirp.wiki",
				});
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

	test("reports a blocked deployment as terminal even when the operation still carries a progress code", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				const operations = yield* Operations;
				const operation = Option.getOrThrow(yield* operations.claim("worker-1", 30_000, "provision"));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const stored = Option.getOrThrow(yield* (yield* Boards).get("user-1", board.id));
				yield* (yield* Deployments).ensure({
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					spec: deploymentSpec(stored.slug, imageRef, settings),
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE board_deployments SET state = 'blocked' WHERE board_id = ${board.id}`;
				yield* operations.requeue({
					id: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					availableAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
					errorCode: "provider_observation_pending",
					errorMessage: "Fly Machine health check is not passing",
				});
				const blocked = Option.getOrThrow(yield* dashboard.get("user-1", board.id));
				expect(blocked).toMatchObject({
					phase: "blocked",
					error: {
						code: "provider_observation_pending",
						message: "Fly Machine health check is not passing",
						retrying: false,
						severity: "error",
					},
				});
				yield* sqlRequeue(board.id, "edge_unavailable");
				expect(Option.getOrThrow(yield* dashboard.get("user-1", board.id))).toMatchObject({
					phase: "blocked",
					error: { code: "edge_unavailable", retrying: false, severity: "error" },
				});
			}),
		);
	});

	test("reports a pending provider observation as progress while the board is still setting up", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const dashboard = yield* Dashboard;
				const board = yield* dashboard.create("user-1", create);
				const operations = yield* Operations;
				const operation = Option.getOrThrow(yield* operations.claim("worker-1", 30_000, "provision"));
				if (!operation.lease_token) return yield* Effect.die("Claim returned no lease token");
				const stored = Option.getOrThrow(yield* (yield* Boards).get("user-1", board.id));
				yield* (yield* Deployments).ensure({
					operationId: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					spec: deploymentSpec(stored.slug, imageRef, settings),
				});
				yield* operations.requeue({
					id: operation.id,
					leaseToken: operation.lease_token,
					workerId: "worker-1",
					availableAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
					errorCode: "provider_observation_pending",
					errorMessage: "Fly Machine health check is not passing",
				});
				expect(Option.getOrThrow(yield* dashboard.get("user-1", board.id))).toMatchObject({
					phase: "provisioning",
					error: { code: "provider_observation_pending", retrying: true, severity: "progress" },
				});
				yield* sqlRequeue(board.id, "machine_start_ambiguous");
				expect(Option.getOrThrow(yield* dashboard.get("user-1", board.id))).toMatchObject({
					error: { code: "machine_start_ambiguous", retrying: true, severity: "progress" },
				});
				yield* sqlRequeue(board.id, "edge_unavailable");
				expect(Option.getOrThrow(yield* dashboard.get("user-1", board.id))).toMatchObject({
					error: { code: "edge_unavailable", retrying: true, severity: "progress" },
				});
				yield* sqlRequeue(board.id, "provider_unavailable");
				expect(Option.getOrThrow(yield* dashboard.get("user-1", board.id))).toMatchObject({
					error: { code: "provider_unavailable", retrying: true, severity: "warning" },
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
				expect(yield* dashboard.list("user-1")).toEqual({
					boards: [ready],
					truncated: false,
					capabilities: { postgres: false },
					boards_domain: "boards.chirp.wiki",
				});
			}),
		);
	});
});
