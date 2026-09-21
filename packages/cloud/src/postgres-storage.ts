import { and, eq, gt, sql } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer, Redacted } from "effect";
import { CloudSecrets } from "./cloud-secrets.ts";
import { Database } from "./database.ts";
import { DeploymentFenceLost } from "./deployment.ts";
import type { DeploymentLease } from "./deployments.ts";
import { FlySecrets } from "./fly-secrets.ts";
import { bootstrapPostgres } from "./postgres-bootstrap.ts";
import { boardOperations, boardPostgresSecrets } from "./schema.ts";

export class PostgresStorageError extends Data.TaggedError("PostgresStorageError")<{
	readonly reason: "missing_credentials" | "not_prepared";
}> {}

const make = (allowLocal: boolean) =>
	Effect.gen(function* () {
		const database = yield* Database;
		const secrets = yield* CloudSecrets;
		const load = (boardId: string) =>
			database
				.select()
				.from(boardPostgresSecrets)
				.where(eq(boardPostgresSecrets.board_id, boardId))
				.limit(1)
				.pipe(
					Effect.flatMap((rows) =>
						rows[0]
							? Effect.succeed(rows[0])
							: Effect.fail(new PostgresStorageError({ reason: "missing_credentials" })),
					),
				);
		const bootstrapInput = (boardId: string, ciphertext: string) =>
			secrets.decryptBootstrap(boardId, ciphertext).pipe(
				Effect.map((secret) => {
					const payload = Redacted.value(secret);
					return {
						boardId,
						adminUrl: Redacted.make(payload.adminUrl),
						bootPassword: Redacted.make(payload.bootPassword),
						appPassword: Redacted.make(payload.appPassword),
						allowLocal,
					};
				}),
			);
		// A stale worker can finish an idempotent external operation, but cannot checkpoint it.
		const mark = (
			boardId: string,
			lease: DeploymentLease,
			changes: { readonly prepared: true; readonly runtimeCiphertext: string } | { readonly flySecretsVersion: number },
		) =>
			database.transaction((transaction) =>
				Effect.gen(function* () {
					const owned = yield* transaction
						.select({ id: boardOperations.id })
						.from(boardOperations)
						.where(
							and(
								eq(boardOperations.id, lease.operationId),
								eq(boardOperations.board_id, boardId),
								eq(boardOperations.kind, "provision"),
								eq(boardOperations.state, "running"),
								eq(boardOperations.lease_token, lease.leaseToken),
								eq(boardOperations.lease_owner, lease.workerId),
								gt(boardOperations.lease_expires_at, sql`clock_timestamp()`),
							),
						)
						.for("update")
						.limit(1);
					if (!owned[0]) return yield* new DeploymentFenceLost({ operationId: lease.operationId });
					yield* transaction
						.update(boardPostgresSecrets)
						.set(
							"prepared" in changes
								? {
										prepared: true,
										bootstrap_ciphertext: null,
										runtime_ciphertext: changes.runtimeCiphertext,
									}
								: { fly_secrets_version: changes.flySecretsVersion },
						)
						.where(eq(boardPostgresSecrets.board_id, boardId));
				}),
			);
		return {
			prepare: (boardId: string, lease: DeploymentLease) =>
				Effect.gen(function* () {
					const row = yield* load(boardId);
					if (row.prepared) {
						if (!row.runtime_ciphertext || row.bootstrap_ciphertext)
							return yield* new PostgresStorageError({ reason: "not_prepared" });
						yield* secrets.decryptRuntime(boardId, row.runtime_ciphertext);
						return;
					}
					if (!row.bootstrap_ciphertext || row.runtime_ciphertext)
						return yield* new PostgresStorageError({ reason: "missing_credentials" });
					// Always verify/reconcile on a reclaimed requested checkpoint. Credentials are never rotated.
					const result = yield* bootstrapPostgres(yield* bootstrapInput(boardId, row.bootstrap_ciphertext));
					const runtimeCiphertext = yield* secrets.prepareRuntime(boardId, {
						bootUrl: Redacted.value(result.bootUrl),
						appUrl: Redacted.value(result.appUrl),
						tls: result.tls,
					});
					yield* mark(boardId, lease, { prepared: true, runtimeCiphertext });
				}),
			stage: (boardId: string, appName: string, lease: DeploymentLease) =>
				Effect.gen(function* () {
					const row = yield* load(boardId);
					if (!row.prepared || row.bootstrap_ciphertext || !row.runtime_ciphertext)
						return yield* new PostgresStorageError({ reason: "not_prepared" });
					if (row.fly_secrets_version !== null) return row.fly_secrets_version;
					const urls = Redacted.value(yield* secrets.decryptRuntime(boardId, row.runtime_ciphertext));
					const fly = yield* FlySecrets;
					const version = yield* fly.ensure(
						appName,
						Redacted.make({
							DATABASE_URL: urls.appUrl,
							BOOT_DATABASE_URL: urls.bootUrl,
							DATABASE_TLS: String(urls.tls),
						}),
					);
					yield* mark(boardId, lease, { flySecretsVersion: version });
					return version;
				}),
			assertReady: (boardId: string) =>
				load(boardId).pipe(
					Effect.flatMap((row) =>
						row.prepared && row.fly_secrets_version !== null
							? Effect.succeed(row.fly_secrets_version)
							: Effect.fail(new PostgresStorageError({ reason: "not_prepared" })),
					),
				),
		};
	});

export class PostgresStorage extends Context.Service<PostgresStorage, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/PostgresStorage",
) {}
export const postgresStorageLayerWithLocal = (allowLocal: boolean) => Layer.effect(PostgresStorage, make(allowLocal));
export const postgresStorageLayer = Layer.unwrap(
	Config.Boolean("CLOUD_POSTGRES_ALLOW_LOCAL").pipe(
		Config.withDefault(false),
		Effect.map(postgresStorageLayerWithLocal),
	),
);
