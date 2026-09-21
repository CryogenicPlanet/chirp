import { BoardDeletion, boardDeletionLayer, type DeleteBoard } from "./board-deletion.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { cloudSecretsLayer } from "./cloud-secrets.ts";
import { boardsLayer } from "./boards.ts";
import type { CreateDashboardBoard } from "./dashboard-contract.ts";
import { Dashboard, dashboardLayer } from "./dashboard.ts";
import { databaseLayer } from "./database.ts";
import { deploymentsLayer } from "./deployments.ts";
import { Invitations, invitationsLayer } from "./invitations.ts";
import { operationsLayer } from "./operations.ts";

const dashboardRequestLayer = dashboardLayer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(boardDeletionLayer, boardsLayer, deploymentsLayer, operationsLayer, invitationsLayer),
	),
	Layer.provideMerge(databaseLayer),
	Layer.provideMerge(cloudSecretsLayer),
	Layer.provideMerge(NodeServices.layer),
);

export const makeDashboardRequestRuntime = (
	layer: Layer.Layer<
		Dashboard | Invitations | BoardDeletion,
		Layer.Error<typeof dashboardRequestLayer>
	> = dashboardRequestLayer,
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
						PostgresUnavailable: () => Effect.succeed({ ok: false as const, code: "postgres_unavailable" as const }),
						InvalidStorageConfiguration: () => Effect.succeed({ ok: false as const, code: "invalid_request" as const }),
						PostgresBootstrapError: (error) =>
							Effect.succeed({
								ok: false as const,
								code:
									error.reason === "unsupported_channel_binding"
										? ("postgres_channel_binding_unsupported" as const)
										: ("invalid_postgres_url" as const),
							}),
						CloudSecretsError: () => Effect.succeed({ ok: false as const, code: "postgres_unavailable" as const }),
						InvalidBoardName: () => Effect.succeed({ ok: false as const, code: "invalid_request" as const }),
						IdempotencyConflict: () => Effect.succeed({ ok: false as const, code: "idempotency_conflict" as const }),
						BoardQuotaExceeded: () => Effect.succeed({ ok: false as const, code: "board_quota_exceeded" as const }),
					}),
				),
			),
		remove: (ownerId: string, boardId: string, input: DeleteBoard) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const result = yield* BoardDeletion.use((deletion) => deletion.request(ownerId, boardId, input));
					if (result.deleted) return { ok: true as const, deleted: true as const };
					const board = yield* Dashboard.use((dashboard) => dashboard.get(ownerId, boardId));
					return board._tag === "Some"
						? { ok: true as const, board: board.value }
						: { ok: true as const, deleted: true as const };
				}).pipe(
					Effect.catchTags({
						BoardNotFound: () => Effect.succeed({ ok: false as const, code: "not_found" as const }),
						BoardConfirmationMismatch: () =>
							Effect.succeed({ ok: false as const, code: "confirmation_mismatch" as const }),
						BoardDeletionUnsafe: () =>
							Effect.succeed({ ok: false as const, code: "provider_ownership_unverified" as const }),
						BoardDeletionFailed: () => Effect.succeed({ ok: false as const, code: "deletion_failed" as const }),
						OperationAlreadyActive: () => Effect.succeed({ ok: false as const, code: "operation_active" as const }),
						IdempotencyConflict: () => Effect.succeed({ ok: false as const, code: "idempotency_conflict" as const }),
					}),
				),
			),
		canInvite: (email: string) => runtime.runPromise(Invitations.use((invitations) => invitations.canIssue(email))),
		invite: (issuer: { readonly id: string; readonly email: string }, email: string) =>
			runtime.runPromise(
				Invitations.use((invitations) => invitations.issueForOperator(issuer, email)).pipe(
					Effect.map((issued) => ({
						ok: true as const,
						token: issued.token,
						expires_at: issued.invitation.expires_at.toISOString(),
					})),
					Effect.catchTags({
						InvalidInvitation: () => Effect.succeed({ ok: false as const, code: "invalid_request" as const }),
						InvitationsForbidden: () => Effect.succeed({ ok: false as const, code: "invitations_forbidden" as const }),
						InvitationRateLimited: () =>
							Effect.succeed({ ok: false as const, code: "invitation_rate_limited" as const }),
					}),
				),
			),
		dispose: () => runtime.dispose(),
	};
};
