import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
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

export const makeDashboardRequestRuntime = (
	layer: Layer.Layer<Dashboard, Layer.Error<typeof dashboardRequestLayer>> = dashboardRequestLayer,
) => {
	const runtime = ManagedRuntime.make(layer);
	return {
		list: (ownerId: string) => runtime.runPromise(Dashboard.use((dashboard) => dashboard.list(ownerId))),
		get: (ownerId: string, boardId: string) =>
			runtime.runPromise(Dashboard.use((dashboard) => dashboard.get(ownerId, boardId))),
		create: (ownerId: string, input: CreateDashboardBoard) =>
			runtime.runPromise(
				Dashboard.use((dashboard) => dashboard.create(ownerId, input)).pipe(
					Effect.map((board) => ({ ok: true as const, board })),
					Effect.catchTags({
						InvalidBoardName: () => Effect.succeed({ ok: false as const, code: "invalid_request" as const }),
						IdempotencyConflict: () => Effect.succeed({ ok: false as const, code: "idempotency_conflict" as const }),
						BoardQuotaExceeded: () => Effect.succeed({ ok: false as const, code: "board_quota_exceeded" as const }),
					}),
				),
			),
		dispose: () => runtime.dispose(),
	};
};
