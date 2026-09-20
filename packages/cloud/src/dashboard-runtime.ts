import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { boardsLayer } from "./boards.ts";
import type { CreateDashboardBoard } from "./dashboard-contract.ts";
import { Dashboard, dashboardLayer } from "./dashboard.ts";
import { databaseLayer } from "./database.ts";
import { deploymentsLayer } from "./deployments.ts";
import { operationsLayer } from "./operations.ts";

const dashboardRequestLayer = dashboardLayer.pipe(
	Layer.provideMerge(Layer.mergeAll(boardsLayer, deploymentsLayer, operationsLayer)),
	Layer.provideMerge(databaseLayer),
	Layer.provideMerge(NodeServices.layer),
);
const run = <A, E>(effect: Effect.Effect<A, E, Dashboard>) =>
	Effect.runPromise(effect.pipe(Effect.provide(dashboardRequestLayer)));

export const listDashboardBoards = (ownerId: string) => run(Dashboard.use((dashboard) => dashboard.list(ownerId)));
export const getDashboardBoard = (ownerId: string, boardId: string) =>
	run(Dashboard.use((dashboard) => dashboard.get(ownerId, boardId)));
export const createDashboardBoard = (ownerId: string, input: CreateDashboardBoard) =>
	run(
		Dashboard.use((dashboard) => dashboard.create(ownerId, input)).pipe(
			Effect.match({
				onFailure: (error) => ({
					ok: false as const,
					code:
						error._tag === "InvalidBoardName"
							? ("invalid_request" as const)
							: error._tag === "IdempotencyConflict"
								? ("idempotency_conflict" as const)
								: ("unavailable" as const),
				}),
				onSuccess: (board) => ({ ok: true as const, board }),
			}),
		),
	);
