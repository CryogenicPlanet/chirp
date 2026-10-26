import { machineMatches } from "./machine-spec.ts";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { account, user } from "./auth-schema.ts";
import { Database } from "./database.ts";
import { FlyBoardApi } from "./fly-board-api.ts";
import { FlySetupApi, SetupCodeIssue } from "./fly-setup-api.ts";
import { BoardNotFound } from "./operation.ts";
import { boardDeployments, boardOperations, boardRoutes, boards } from "./schema.ts";

/**
 * Where "Open board" sends the owner, or the copy-code panel when the board cannot take a prefilled setup: an older
 * image's panel shows the code this Open already issued, so no second exec replaces it.
 */
export type BoardOpen =
	| { readonly url: string }
	| { readonly fallback: "setup_code"; readonly code: string; readonly expires_at: string }
	| { readonly fallback: "setup_code" };

const unavailable = () => new SetupCodeIssue({ code: "setup_code_unavailable" });
const hostnamePattern = /^(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63}$/;
// better-auth stores GitHub's numeric `id` and Google's `sub` as accountId: the part auth.chirp.wiki puts after the prefix.
const providers = [
	{ id: "github", name: "GitHub", accountId: /^[1-9][0-9]{0,19}$/ },
	{ id: "google", name: "Google", accountId: /^[A-Za-z0-9._-]{1,255}$/ },
] as const;

/** The board shows this beside the linked identity: one line of printable text, at most 100 UTF-16 units. */
const identityLabel = (name: string, fallback: string) => {
	const printable = name.replace(/\s/gu, " ").replace(/\p{C}/gu, "").replace(/ {2,}/g, " ").trim();
	let label = "";
	for (const character of printable) {
		if (label.length + character.length > 100) break;
		label += character;
	}
	return label.trim() || fallback;
};

const make = (organization: string) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const fly = yield* FlyBoardApi;
		const setup = yield* FlySetupApi;
		// At most one identity per provider, GitHub first: the most recently updated account with a valid id.
		const ownerIdentities = (ownerId: string) =>
			Effect.gen(function* () {
				const rows = yield* db
					.select({ provider: account.providerId, accountId: account.accountId, name: user.name })
					.from(account)
					.innerJoin(user, eq(user.id, account.userId))
					.where(and(eq(account.userId, ownerId), inArray(account.providerId, ["github", "google"])))
					.orderBy(desc(account.updatedAt))
					.limit(16);
				return providers.flatMap((provider) => {
					const row = rows.find(
						(candidate) => candidate.provider === provider.id && provider.accountId.test(candidate.accountId),
					);
					return row
						? [
								{
									provider: provider.id,
									subject: `${provider.id}:${row.accountId}`,
									label: identityLabel(row.name, provider.name),
								},
							]
						: [];
				});
			});
		const usableHostname = (
			deployment: typeof boardDeployments.$inferSelect | undefined,
			route: typeof boardRoutes.$inferSelect | undefined,
		) =>
			deployment &&
			deployment.state === "provisioned" &&
			route &&
			route.hostname === deployment.hostname &&
			route.app_name === deployment.app_name &&
			hostnamePattern.test(deployment.hostname)
				? deployment.hostname
				: undefined;
		const issue = (ownerId: string, boardId: string) =>
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
					const hostname = usableHostname(deployment, route);
					if (
						active.length ||
						!deployment ||
						!hostname ||
						!deployment.app_id ||
						!deployment.machine_id ||
						!deployment.volume_id
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
					if (machine.id !== deployment.machine_id || !machineMatches(machine, deployment)) return yield* unavailable();
					if (machine.state !== "started") {
						if (machine.state !== "stopped" && machine.state !== "suspended") return yield* unavailable();
						yield* setup.wake(hostname);
						found = yield* fly.getMachine(deployment.app_name, deployment.machine_id);
						if (
							Option.isNone(found) ||
							found.value.id !== machine.id ||
							!machineMatches(found.value, deployment) ||
							found.value.state !== "started"
						)
							return yield* unavailable();
					}
					const identities = yield* ownerIdentities(ownerId);
					const result = yield* setup.issue(
						deployment.app_name,
						deployment.machine_id,
						identities.map(({ subject, label }) => ({ subject, label })),
					);
					return {
						...result,
						onboarding_url: `https://${hostname}/onboarding`,
						// A fragment never reaches a server and is stripped from Referer.
						setup_url: `https://${hostname}/setup#code=${encodeURIComponent(result.code)}`,
					};
				}).pipe(
					Effect.timeout("30 seconds"),
					Effect.catchTag("TimeoutError", unavailable),
					Effect.catchTag("FlyApiError", unavailable),
				),
			);
		return {
			issue,
			open: (ownerId: string, boardId: string) =>
				Effect.gen(function* () {
					const board = (yield* db
						.select({ deletion_requested_at: boards.deletion_requested_at })
						.from(boards)
						.where(and(eq(boards.id, boardId), eq(boards.owner_id, ownerId), isNull(boards.deleted_at)))
						.limit(1))[0];
					if (!board) return yield* new BoardNotFound({ boardId });
					const deployment = (yield* db
						.select()
						.from(boardDeployments)
						.where(eq(boardDeployments.board_id, boardId))
						.limit(1))[0];
					const route = (yield* db.select().from(boardRoutes).where(eq(boardRoutes.board_id, boardId)).limit(1))[0];
					const hostname = usableHostname(deployment, route);
					if (board.deletion_requested_at || !hostname) return yield* unavailable();
					const identities = yield* ownerIdentities(ownerId);
					const provider = identities[0]?.provider;
					const login: BoardOpen = {
						url: provider
							? `https://${hostname}/auth/login?provider=${provider}&next=/`
							: `https://${hostname}/auth/login`,
					};
					// A public read that also wakes the board, so a board with a passkey never needs Fly exec.
					if (!(yield* setup.setupRequired(hostname))) return login;
					// Exactly one exec: a new image prefills /setup from the fragment whether or not it linked anyone.
					return yield* issue(ownerId, boardId).pipe(
						Effect.map((issued): BoardOpen =>
							issued.identities === undefined
								? { fallback: "setup_code", code: issued.code, expires_at: issued.expires_at }
								: { url: issued.setup_url },
						),
						Effect.catchTag("SetupCodeIssue", (problem): Effect.Effect<BoardOpen, SetupCodeIssue> =>
							problem.code === "setup_closed"
								? Effect.succeed(login)
								: problem.code === "setup_code_unsupported"
									? Effect.succeed({ fallback: "setup_code" })
									: Effect.fail(problem),
						),
					);
				}),
		};
	});
export class BoardSetup extends Context.Service<BoardSetup, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/BoardSetup",
) {}
export const boardSetupLayer = (organization: string) => Layer.effect(BoardSetup, make(organization));
