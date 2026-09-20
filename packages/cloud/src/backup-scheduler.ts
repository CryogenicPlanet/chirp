import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Operations } from "./operations.ts";

const dueBoards = Schema.decodeUnknownEffect(
	Schema.Array(Schema.Struct({ board_id: Schema.String, owner_id: Schema.String })),
);

const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const operations = yield* Operations;
	return {
		scheduleDue: Effect.gen(function* () {
			const now = yield* DateTime.now;
			const hour = DateTime.formatIso(now).slice(0, 13);
			const due = yield* sql`SELECT d.board_id, b.owner_id
				FROM board_deployments d
				JOIN boards b ON b.id = d.board_id
				WHERE d.state = 'provisioned' AND d.storage_engine = 'sqlite'
					AND (d.last_snapshot_created_at IS NULL
						OR d.last_snapshot_created_at <= clock_timestamp() - interval '24 hours')
					AND NOT EXISTS (
						SELECT 1 FROM board_operations o
						WHERE o.board_id = d.board_id AND o.state IN ('queued', 'running')
					)
				ORDER BY d.last_snapshot_created_at NULLS FIRST, d.board_id
				LIMIT 100`.pipe(Effect.flatMap(dueBoards));
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
						Effect.catchTag("OperationAlreadyActive", () => Effect.succeed(false)),
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
