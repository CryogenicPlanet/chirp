import { and, asc, eq, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { Database } from "./database.ts";
import { Operations } from "./operations.ts";
import { boardDeployments, boardOperations, boards } from "./schema.ts";

const make = Effect.gen(function* () {
	const db = yield* Database;
	const operations = yield* Operations;
	return {
		scheduleDue: Effect.gen(function* () {
			const now = yield* DateTime.now;
			const hour = DateTime.formatIso(now).slice(0, 13);
			const due = yield* db
				.select({ board_id: boardDeployments.board_id, owner_id: boards.owner_id })
				.from(boardDeployments)
				.innerJoin(boards, eq(boards.id, boardDeployments.board_id))
				.where(
					and(
						eq(boardDeployments.state, "provisioned"),
						isNull(boards.deletion_requested_at),
						isNull(boards.deleted_at),
						eq(boardDeployments.storage_engine, "sqlite"),
						or(
							isNull(boardDeployments.last_snapshot_created_at),
							lte(boardDeployments.last_snapshot_created_at, sql<Date>`clock_timestamp() - interval '24 hours'`),
						),
						notExists(
							db
								.select({ id: boardOperations.id })
								.from(boardOperations)
								.where(
									and(
										eq(boardOperations.board_id, boardDeployments.board_id),
										inArray(boardOperations.state, ["queued", "running"]),
									),
								),
						),
					),
				)
				.orderBy(sql`${boardDeployments.last_snapshot_created_at} ASC NULLS FIRST`, asc(boardDeployments.board_id))
				.limit(100);
			let scheduled = 0;
			for (const board of due) {
				const inserted = yield* operations
					.enqueue({
						board_id: board.board_id,
						owner_id: board.owner_id,
						kind: "backup",
						requested_by: "system:backup",
						idempotency_key: `backup:${board.board_id}:${hour}`,
					})
					.pipe(
						Effect.map((operation) => operation.state === "queued"),
						Effect.catchTags({
							OperationAlreadyActive: () => Effect.succeed(false),
							BoardNotFound: () => Effect.succeed(false),
						}),
					);
				if (inserted) scheduled += 1;
			}
			return scheduled;
		}),
	};
});

export class BackupScheduler extends Context.Service<BackupScheduler, Effect.Success<typeof make>>()(
	"comms/cloud/BackupScheduler",
) {}
export const backupSchedulerLayer = Layer.effect(BackupScheduler, make);
