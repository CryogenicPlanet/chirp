import { machineMatches } from "./machine-spec.ts";
import { and, eq, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { Database } from "./database.ts";
import { FlyBoardApi } from "./fly-board-api.ts";
import { FlySetupApi, SetupCodeIssue } from "./fly-setup-api.ts";
import { BoardNotFound } from "./operation.ts";
import { boardDeployments, boardOperations, boardRoutes, boards } from "./schema.ts";

const unavailable = () => new SetupCodeIssue({ code: "setup_code_unavailable" });
const make = (organization: string) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const fly = yield* FlyBoardApi;
		const setup = yield* FlySetupApi;
		return {
			issue: (ownerId: string, boardId: string) =>
				db.transaction(() =>
					Effect.gen(function* () {
						// Deletion and operation enqueue take this same board lock first. Keep it until bounded exec finishes.
						const board = (yield* db
							.select()
							.from(boards)
							.where(and(eq(boards.id, boardId), eq(boards.owner_id, ownerId), isNull(boards.deleted_at)))
							.for("update", { noWait: true })
							.limit(1))[0];
						if (!board) return yield* new BoardNotFound({ boardId });
						if (board.deletion_requested_at) return yield* unavailable();
						const active = yield* db
							.select({ id: boardOperations.id })
							.from(boardOperations)
							.where(
								and(
									eq(boardOperations.board_id, boardId),
									or(eq(boardOperations.state, "running"), eq(boardOperations.state, "queued")),
								),
							)
							.limit(1);
						const deployment = (yield* db
							.select()
							.from(boardDeployments)
							.where(eq(boardDeployments.board_id, boardId))
							.limit(1))[0];
						const route = (yield* db.select().from(boardRoutes).where(eq(boardRoutes.board_id, boardId)).limit(1))[0];
						if (
							active.length ||
							!deployment ||
							deployment.state !== "provisioned" ||
							!deployment.app_id ||
							!deployment.machine_id ||
							!deployment.volume_id ||
							!route ||
							route.hostname !== deployment.hostname ||
							route.app_name !== deployment.app_name ||
							!/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}$/.test(deployment.hostname)
						)
							return yield* unavailable();
						const observed = yield* fly.getApp(deployment.app_name);
						if (Option.isNone(observed)) return yield* unavailable();
						const app = observed.value;
						if (
							app.id !== deployment.app_id ||
							app.name !== deployment.app_name ||
							app.name !== `chirp-${board.slug}` ||
							app.organization.slug !== organization ||
							app.network !== deployment.network_name ||
							app.network !== `chirp-${board.slug}`
						)
							return yield* unavailable();
						let found = yield* fly.getMachine(deployment.app_name, deployment.machine_id);
						if (Option.isNone(found)) return yield* unavailable();
						const machine = found.value;
						if (machine.id !== deployment.machine_id || !machineMatches(machine, deployment))
							return yield* unavailable();
						if (machine.state !== "started") {
							if (machine.state !== "stopped" && machine.state !== "suspended") return yield* unavailable();
							yield* setup.wake(deployment.hostname);
							found = yield* fly.getMachine(deployment.app_name, deployment.machine_id);
							if (
								Option.isNone(found) ||
								found.value.id !== machine.id ||
								!machineMatches(found.value, deployment) ||
								found.value.state !== "started"
							)
								return yield* unavailable();
						}
						const result = yield* setup.issue(deployment.app_name, deployment.machine_id);
						return { ...result, onboarding_url: `https://${deployment.hostname}/onboarding` };
					}).pipe(
						Effect.timeout("30 seconds"),
						Effect.catchTag("TimeoutError", unavailable),
						Effect.catchTag("FlyApiError", unavailable),
					),
				),
		};
	});
export class BoardSetup extends Context.Service<BoardSetup, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/BoardSetup",
) {}
export const boardSetupLayer = (organization: string) => Layer.effect(BoardSetup, make(organization));
