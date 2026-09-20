import { desc, eq, getTableColumns } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import type { Board } from "./board.ts";
import { Boards, maxBoardsPerOwner } from "./boards.ts";
import { Database } from "./database.ts";
import type { CreateDashboardBoard, DashboardBoard, DashboardPhase } from "./dashboard-contract.ts";
import type { Deployment } from "./deployment.ts";
import { Deployments } from "./deployments.ts";
import type { Operation } from "./operation.ts";
import { Operations } from "./operations.ts";
import { boardDeployments, boardOperations, boards as boardTable } from "./schema.ts";

export class InvalidBoardName extends Data.TaggedError("InvalidBoardName")<{}> {}

type DashboardOperation = Pick<Operation, "checkpoint" | "last_error_code" | "last_error_message" | "state">;

const phase = (deployment: Deployment | undefined, operation: DashboardOperation | undefined): DashboardPhase => {
	if (operation?.state === "failed") return "blocked";
	if (!deployment) return operation?.state === "running" ? "provisioning" : "queued";
	if (deployment.state === "blocked") return "blocked";
	return deployment.state === "provisioned" ? "ready" : "provisioning";
};

const view = (
	board: Board,
	deployment: Deployment | undefined,
	operation: DashboardOperation | undefined,
): DashboardBoard => ({
	id: board.id,
	name: board.name,
	hostname: deployment?.state === "provisioned" ? deployment.hostname : null,
	storage_engine: board.storage_engine,
	region: deployment?.region ?? null,
	volume_size_gb: deployment?.volume_size_gb ?? null,
	phase: phase(deployment, operation),
	checkpoint: deployment?.state ?? operation?.checkpoint ?? "requested",
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
				retrying: operation.state === "queued" || operation.state === "running",
			}
		: null,
});

const make = Effect.gen(function* () {
	const boards = yield* Boards;
	const deployments = yield* Deployments;
	const operations = yield* Operations;
	const database = yield* Database;
	const latestProvision = database
		.selectDistinctOn([boardOperations.board_id], {
			board_id: boardOperations.board_id,
			state: boardOperations.state,
			checkpoint: boardOperations.checkpoint,
			last_error_code: boardOperations.last_error_code,
			last_error_message: boardOperations.last_error_message,
		})
		.from(boardOperations)
		.where(eq(boardOperations.kind, "provision"))
		.orderBy(boardOperations.board_id, desc(boardOperations.created_at), desc(boardOperations.id))
		.as("latest_provision");
	const decorate = (board: Board) =>
		Effect.all([deployments.get(board.id), operations.latest(board.id, "provision")]).pipe(
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
						state: latestProvision.state,
						checkpoint: latestProvision.checkpoint,
						last_error_code: latestProvision.last_error_code,
						last_error_message: latestProvision.last_error_message,
					},
				})
				.from(boardTable)
				.leftJoin(boardDeployments, eq(boardDeployments.board_id, boardTable.id))
				.leftJoin(latestProvision, eq(latestProvision.board_id, boardTable.id))
				.where(eq(boardTable.owner_id, ownerId))
				.orderBy(desc(boardTable.created_at), desc(boardTable.id))
				.limit(maxBoardsPerOwner)
				.pipe(
					Effect.map((rows) =>
						rows.map(({ board, deployment, operation }) =>
							view(board, deployment ?? undefined, operation ?? undefined),
						),
					),
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
				const board = yield* boards.request({
					owner_id: ownerId,
					name,
					storage_engine: "sqlite",
					requested_by: ownerId,
					idempotency_key: input.idempotency_key,
				});
				return yield* decorate(board);
			}),
	};
});

export class Dashboard extends Context.Service<Dashboard, Effect.Success<typeof make>>()("comms/cloud/Dashboard") {}
export const dashboardLayer = Layer.effect(Dashboard, make);
