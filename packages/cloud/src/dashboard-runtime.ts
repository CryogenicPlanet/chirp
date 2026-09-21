import { Config } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BoardSetup, boardSetupLayer } from "./board-setup.ts";
import { flyBoardApiLayer } from "./fly-board-api.ts";
import { flySetupApiLayer, SetupCodeIssue } from "./fly-setup-api.ts";
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

const setupLayer = Layer.unwrap(
	Effect.all({
		token: Config.Redacted("FLY_API_TOKEN").pipe(Config.option),
		organization: Config.String("FLY_ORGANIZATION").pipe(Config.withDefault("")),
	}).pipe(
		Effect.map(({ token, organization }) =>
			token._tag === "Some" && organization
				? boardSetupLayer(organization).pipe(
						Layer.provide(
							Layer.mergeAll(flyBoardApiLayer({ token: token.value }), flySetupApiLayer({ token: token.value })).pipe(
								Layer.provide(FetchHttpClient.layer),
							),
						),
					)
				: Layer.succeed(BoardSetup, {
						issue: () => Effect.fail(new SetupCodeIssue({ code: "setup_code_unavailable" })),
					}),
		),
	),
);

const dashboardRequestLayer = dashboardLayer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(setupLayer, boardDeletionLayer, boardsLayer, deploymentsLayer, operationsLayer, invitationsLayer),
	),
	Layer.provideMerge(databaseLayer),
	Layer.provideMerge(cloudSecretsLayer),
	Layer.provideMerge(NodeServices.layer),
);

export const makeDashboardRequestRuntime = (
	layer: Layer.Layer<
		Dashboard | Invitations | BoardDeletion | BoardSetup,
		Layer.Error<typeof dashboardRequestLayer>
	> = dashboardRequestLayer,
) => {
	const runtime = ManagedRuntime.make(layer);
	return {
		setupCode: (ownerId: string, boardId: string) =>
			runtime.runPromise(
				BoardSetup.use((setup) => setup.issue(ownerId, boardId)).pipe(
					Effect.map((result) => ({ ok: true as const, ...result })),
					Effect.catchTags({
						BoardNotFound: () => Effect.succeed({ ok: false as const, code: "not_found" as const }),
						SetupCodeIssue: (issue) => Effect.succeed({ ok: false as const, code: issue.code }),
					}),
				),
			),
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
						InvalidBoardSlug: () => Effect.succeed({ ok: false as const, code: "invalid_slug" as const }),
						BoardSlugUnavailable: () => Effect.succeed({ ok: false as const, code: "slug_unavailable" as const }),
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
		invite: (issuer: { readonly id: string; readonly email: string }) =>
			runtime.runPromise(
				Invitations.use((invitations) => invitations.issueForOperator(issuer)).pipe(
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
