import { and, desc, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";
import type { Board } from "./board.ts";
import { Boards, maxListedBoardsPerOwner } from "./boards.ts";
import { CloudSecrets } from "./cloud-secrets.ts";
import { validatePostgresUrl } from "./postgres-bootstrap.ts";
import { Database } from "./database.ts";
import type {
	CreateDashboardBoard,
	DashboardBoard,
	DashboardErrorSeverity,
	DashboardPhase,
} from "./dashboard-contract.ts";
import type { Deployment } from "./deployment.ts";
import { Deployments } from "./deployments.ts";
import type { Operation } from "./operation.ts";
import { Operations } from "./operations.ts";
import { boardDeployments, boardOperations, boards as boardTable } from "./schema.ts";

export class InvalidStorageConfiguration extends Data.TaggedError("InvalidStorageConfiguration")<{}> {}
export class PostgresUnavailable extends Data.TaggedError("PostgresUnavailable")<{}> {}

export class InvalidBoardName extends Data.TaggedError("InvalidBoardName")<{}> {}

type DashboardOperation = Pick<
	Operation,
	| "id"
	| "attempt"
	| "updated_at"
	| "available_at"
	| "kind"
	| "checkpoint"
	| "last_error_code"
	| "last_error_message"
	| "state"
>;

const phase = (deployment: Deployment | undefined, operation: DashboardOperation | undefined): DashboardPhase => {
	if (operation?.kind === "delete") return operation.state === "failed" ? "deletion_blocked" : "deleting";
	if (operation?.state === "failed") return "blocked";
	if (!deployment) return operation?.state === "running" ? "provisioning" : "queued";
	if (deployment.state === "blocked") return "blocked";
	return deployment.state === "provisioned" ? "ready" : "provisioning";
};

// A stopped board never recovers on its own: an operator has to resolve the reported issue and
// resume the recorded checkpoint.
const stopped = (value: DashboardPhase) => value === "blocked" || value === "deletion_blocked";

// Waiting for a provider observation to settle, including a recorded ambiguous mutation, is how a
// healthy first boot looks; it spends no failure budget and needs no operator. An unreachable board
// is the same kind of waiting: `/health` and `/init` answer 503 for the first minutes of a board's
// life while it installs its runtime. A terminal state is classified before this, so these codes read
// as progress only while the operation is still queued or running and the deployment is not blocked.
const progressing = (code: string) =>
	code === "provider_observation_pending" || code === "edge_unavailable" || code.endsWith("_ambiguous");

// These codes stop provisioning the moment they are recorded, so they never read as progress even
// if a later write has not moved the deployment yet.
const definite = (code: string) =>
	code === "provider_rejected" || code === "provider_drift" || code === "retry_exhausted";

const severity = (value: DashboardPhase, operation: DashboardOperation, code: string): DashboardErrorSeverity =>
	stopped(value) || operation.state === "failed" || definite(code)
		? "error"
		: progressing(code)
			? "progress"
			: "warning";

const view = (
	board: Board,
	deployment: Deployment | undefined,
	operation: DashboardOperation | undefined,
): DashboardBoard => {
	const boardPhase = phase(deployment, operation);
	return {
		id: board.id,
		name: board.name,
		hostname: operation?.kind !== "delete" && deployment?.state === "provisioned" ? deployment.hostname : null,
		storage_engine: board.storage_engine,
		region: deployment?.region ?? null,
		volume_size_gb: deployment?.volume_size_gb ?? null,
		phase: boardPhase,
		checkpoint:
			operation?.kind === "delete" || deployment?.state === "blocked"
				? (operation?.checkpoint ?? "requested")
				: (deployment?.state ?? operation?.checkpoint ?? "requested"),
		operation: operation
			? {
					id: operation.id,
					state: operation.state,
					attempt: operation.attempt,
					updated_at: operation.updated_at.toISOString(),
					next_attempt_at: operation.state === "queued" ? operation.available_at.toISOString() : null,
				}
			: null,
		created_at: board.created_at.toISOString(),
		last_backup:
			board.storage_engine === "sqlite" &&
			deployment?.last_snapshot_id &&
			deployment.last_snapshot_created_at &&
			deployment.last_snapshot_digest &&
			deployment.last_snapshot_retention_days !== null
				? {
						id: deployment.last_snapshot_id,
						created_at: deployment.last_snapshot_created_at.toISOString(),
						digest: deployment.last_snapshot_digest,
						retention_days: deployment.last_snapshot_retention_days,
					}
				: null,
		error: operation?.last_error_code
			? {
					code: operation.last_error_code,
					message: operation.last_error_message ?? "Provisioning needs attention",
					// A stopped board keeps its last recorded code for diagnosis, but that code never
					// promises another attempt: the operation state and the blocked deployment decide.
					retrying: !stopped(boardPhase) && (operation.state === "queued" || operation.state === "running"),
					severity: severity(boardPhase, operation, operation.last_error_code),
				}
			: null,
	};
};

const make = Effect.gen(function* () {
	const boards = yield* Boards;
	const secrets = yield* CloudSecrets;
	const allowLocal = yield* Config.Boolean("CLOUD_POSTGRES_ALLOW_LOCAL").pipe(Config.withDefault(false));
	const deployments = yield* Deployments;
	const operations = yield* Operations;
	const database = yield* Database;
	const latestProvision = database
		.selectDistinctOn([boardOperations.board_id], {
			board_id: boardOperations.board_id,
			id: boardOperations.id,
			attempt: boardOperations.attempt,
			updated_at: boardOperations.updated_at,
			available_at: boardOperations.available_at,
			kind: boardOperations.kind,
			state: boardOperations.state,
			checkpoint: boardOperations.checkpoint,
			last_error_code: boardOperations.last_error_code,
			last_error_message: boardOperations.last_error_message,
		})
		.from(boardOperations)
		.where(inArray(boardOperations.kind, ["provision", "delete"]))
		.orderBy(boardOperations.board_id, desc(boardOperations.created_at), desc(boardOperations.id))
		.as("latest_provision");
	const decorate = (board: Board) =>
		Effect.all([deployments.get(board.id), operations.latestLifecycle(board.id)]).pipe(
			Effect.map(([deployment, operation]) =>
				view(board, Option.getOrUndefined(deployment), Option.getOrUndefined(operation)),
			),
		);
	return {
		list: (ownerId: string) =>
			database
				.select({
					board: getTableColumns(boardTable),
					deployment: getTableColumns(boardDeployments),
					operation: {
						id: latestProvision.id,
						attempt: latestProvision.attempt,
						updated_at: latestProvision.updated_at,
						available_at: latestProvision.available_at,
						kind: latestProvision.kind,
						state: latestProvision.state,
						checkpoint: latestProvision.checkpoint,
						last_error_code: latestProvision.last_error_code,
						last_error_message: latestProvision.last_error_message,
					},
				})
				.from(boardTable)
				.leftJoin(boardDeployments, eq(boardDeployments.board_id, boardTable.id))
				.leftJoin(latestProvision, eq(latestProvision.board_id, boardTable.id))
				.where(and(eq(boardTable.owner_id, ownerId), isNull(boardTable.deleted_at)))
				.orderBy(desc(boardTable.created_at), desc(boardTable.id))
				.limit(maxListedBoardsPerOwner + 1)
				.pipe(
					Effect.map((rows) => ({
						boards: rows
							.slice(0, maxListedBoardsPerOwner)
							.map(({ board, deployment, operation }) => view(board, deployment ?? undefined, operation ?? undefined)),
						truncated: rows.length > maxListedBoardsPerOwner,
						capabilities: { postgres: secrets.enabled },
					})),
				),
		get: (ownerId: string, boardId: string) =>
			boards.get(ownerId, boardId).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (board) => decorate(board).pipe(Effect.asSome),
					}),
				),
			),
		create: (ownerId: string, input: CreateDashboardBoard) =>
			Effect.gen(function* () {
				const name = input.name.trim();
				if (name.length < 1 || name.length > 80) return yield* new InvalidBoardName();
				const storageEngine = input.storage_engine ?? "sqlite";
				if (storageEngine === "postgres" && !secrets.enabled) return yield* new PostgresUnavailable();
				if ((storageEngine === "postgres") !== Boolean(input.postgres_admin_url))
					return yield* new InvalidStorageConfiguration();
				const adminUrl = input.postgres_admin_url ? Redacted.make(input.postgres_admin_url) : undefined;
				if (adminUrl) yield* validatePostgresUrl(adminUrl, allowLocal);
				const board = yield* boards.request({
					owner_id: ownerId,
					name,
					storage_engine: storageEngine,
					...(adminUrl ? { postgres_admin_url: adminUrl } : {}),
					requested_by: ownerId,
					idempotency_key: input.idempotency_key,
				});
				return yield* decorate(board);
			}),
	};
});

export class Dashboard extends Context.Service<Dashboard, Effect.Success<typeof make>>()("comms/cloud/Dashboard") {}
export const dashboardLayer = Layer.effect(Dashboard, make);
