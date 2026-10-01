import { isIPv4 } from "node:net";
import { and, eq, gt, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer, Option } from "effect";
import { CloudflareDeletionApi } from "./cloudflare-deletion-api.ts";
import { type CloudflareApiError, CloudflareDns, type DnsRecord } from "./cloudflare-dns.ts";
import { Database } from "./database.ts";
import { Deployments } from "./deployments.ts";
import { type FlyApiError, FlyBoardApi } from "./fly-board-api.ts";
import { FlyDeletionApi } from "./fly-deletion-api.ts";
import type { FlyMachine, FlyVolume } from "./fly-model.ts";
import { LeaseLost, type Operation } from "./operation.ts";
import { Operations } from "./operations.ts";
import type { ProvisioningSettings } from "./provisioning-settings.ts";
import { boardOperations, boardPostgresSecrets, boardRoutes, boards } from "./schema.ts";

class DeletionIssue extends Data.TaggedError("DeletionIssue")<{
	readonly code: string;
	readonly message: string;
	readonly retry: boolean;
}> {}
const drift = (message: string) => new DeletionIssue({ code: "deletion_provider_drift", message, retry: false });
const pending = (message = "Waiting for Fly to confirm resource removal") =>
	new DeletionIssue({ code: "deletion_pending", message, retry: true });
const providerFailure = (provider: string, error: CloudflareApiError | FlyApiError) =>
	new DeletionIssue({
		code: "deletion_provider_unavailable",
		message: `${provider} could not confirm deletion; resources remain visible until verified`,
		retry: error.reason !== "status" || error.status === 429 || (error.status !== null && error.status >= 500),
	});
const exactRecord = (record: DnsRecord, name: string, type: "A" | "TXT", content: string) =>
	record.name === name &&
	record.type === type &&
	record.ttl === 60 &&
	(type === "A" ? record.proxied === false : record.proxied !== true) &&
	(record.content === content || (type === "TXT" && record.content === `"${content}"`));

const make = (settings: ProvisioningSettings) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const deployments = yield* Deployments;
		const operations = yield* Operations;
		const fly = yield* FlyBoardApi;
		const remove = yield* FlyDeletionApi;
		const dns = yield* CloudflareDns;
		const removeDns = yield* CloudflareDeletionApi;
		return {
			run: (operation: Operation, workerId: string) =>
				Effect.gen(function* () {
					if (operation.kind !== "delete" || !operation.lease_token)
						return yield* Effect.die("Expected leased delete operation");
					const lease = { id: operation.id, leaseToken: operation.lease_token, workerId };
					const renew = operations.renew({ ...lease, leaseMilliseconds: 90_000 });
					const flow = Effect.gen(function* () {
						const board = (yield* db.select().from(boards).where(eq(boards.id, operation.board_id)).limit(1))[0];
						if (!board?.deletion_requested_at || board.deleted_at) return yield* drift("Board deletion state changed");
						if (operation.checkpoint !== "requested" && operation.checkpoint !== "dns_withdrawn")
							return yield* drift("Board deletion checkpoint is not recognized");
						const found = yield* deployments.get(operation.board_id);
						if (Option.isNone(found)) return yield* drift("Deployment metadata is missing");
						const deployment = found.value;
						// Never adopt provider resources while deleting. Recorded IDs and exact board identities are mandatory.
						const observeApp = Effect.gen(function* () {
							const observed = yield* fly.getApp(deployment.app_name);
							if (Option.isSome(observed)) {
								const app = observed.value;
								if (
									!deployment.app_id ||
									app.id !== deployment.app_id ||
									app.name !== `chirp-${board.slug}` ||
									app.name !== deployment.app_name ||
									app.network !== deployment.network_name ||
									app.network !== `chirp-${board.slug}` ||
									app.organization.slug !== settings.organization
								)
									return yield* drift("Fly App identity does not match this board; no resources were adopted");
							}
							return observed;
						});
						const app = yield* observeApp;
						let machines: ReadonlyArray<FlyMachine> = [];
						let volumes: ReadonlyArray<FlyVolume> = [];
						let address: string | undefined;
						let ownershipValue: string | undefined;
						if (Option.isSome(app)) {
							machines = yield* fly.listMachines(deployment.app_name);
							volumes = yield* fly.listVolumes(deployment.app_name);
							if (
								machines.some(
									(machine) =>
										machine.id !== deployment.machine_id ||
										machine.name !== deployment.machine_name ||
										machine.region !== deployment.region ||
										machine.config.metadata["chirp.deployment_id"] !== board.id,
								)
							)
								return yield* drift("Fly App contains an untracked or changed Machine; deletion needs operator review");
							if (
								volumes.some(
									(volume) =>
										volume.id !== deployment.volume_id ||
										volume.name !== deployment.volume_name ||
										volume.region !== deployment.region ||
										(volume.attached_machine_id && volume.attached_machine_id !== deployment.machine_id),
								)
							)
								return yield* drift("Fly App contains an untracked or changed Volume; deletion needs operator review");
							const ips = yield* fly.listIpAssignments(deployment.app_name);
							if (ips.length > 1 || ips.some((ip) => !ip.shared || ip.egress === true || !isIPv4(ip.ip)))
								return yield* drift("Fly App IP assignments do not match the managed board identity");
							address = ips[0]?.ip;
							const certificate = yield* fly.getCertificate(deployment.app_name, deployment.hostname);
							if (Option.isSome(certificate)) {
								const value = certificate.value;
								const addresses = value.dns_requirements?.a;
								const ownership = value.dns_requirements?.ownership;
								if (
									value.hostname !== deployment.hostname ||
									value.acme_requested === false ||
									value.certificates?.some((entry) => entry.source === "custom") ||
									(address !== undefined && addresses != null && !addresses.includes(address)) ||
									(ownership != null &&
										(ownership.name !== `_fly-ownership.${deployment.hostname}` ||
											typeof ownership.app_value !== "string" ||
											!/^app-[a-zA-Z0-9]+$/.test(ownership.app_value)))
								)
									return yield* drift("Fly certificate identity does not match the managed board");
								ownershipValue = ownership?.app_value ?? undefined;
							}
						}
						const ownershipName = `_fly-ownership.${deployment.hostname}`;
						let addressRecords = yield* dns.listRecords(deployment.hostname);
						let ownershipRecords = yield* dns.listRecords(ownershipName);
						if (
							addressRecords.length > 0 &&
							(address === undefined ||
								addressRecords.length !== 1 ||
								!exactRecord(addressRecords[0]!, deployment.hostname, "A", address))
						)
							return yield* drift("Cloudflare address record does not match the managed board");
						if (
							ownershipRecords.length > 0 &&
							(ownershipValue === undefined ||
								ownershipRecords.length !== 1 ||
								!exactRecord(ownershipRecords[0]!, ownershipName, "TXT", ownershipValue))
						)
							return yield* drift("Cloudflare ownership record does not match the managed board");
						const withdrewDns = addressRecords.length > 0 || ownershipRecords.length > 0;
						for (const record of [...addressRecords, ...ownershipRecords]) {
							yield* observeApp;
							yield* renew;
							yield* removeDns.record(record.id);
						}
						if (withdrewDns) {
							addressRecords = yield* dns.listRecords(deployment.hostname);
							ownershipRecords = yield* dns.listRecords(ownershipName);
							if (addressRecords.length || ownershipRecords.length)
								return yield* pending("Waiting for Cloudflare to confirm DNS record removal");
						}
						if (operation.checkpoint === "requested")
							yield* operations.checkpoint({ ...lease, expected: "requested", next: "dns_withdrawn" });
						if (withdrewDns || operation.checkpoint === "requested")
							return yield* pending("Waiting for withdrawn DNS records to expire from caches");
						const currentApp = yield* observeApp;
						if (Option.isSome(currentApp)) {
							if (machines[0]) {
								yield* observeApp;
								yield* renew;
								yield* remove.machine(deployment.app_name, machines[0].id);
								if (Option.isSome(yield* fly.getMachine(deployment.app_name, machines[0].id))) return yield* pending();
							}
							if (volumes[0]) {
								yield* observeApp;
								yield* renew;
								yield* remove.volume(deployment.app_name, volumes[0].id);
								if (Option.isSome(yield* fly.getVolume(deployment.app_name, volumes[0].id))) return yield* pending();
							}
							yield* observeApp;
							yield* renew;
							if (
								(yield* fly.listMachines(deployment.app_name)).length ||
								(yield* fly.listVolumes(deployment.app_name)).length
							)
								return yield* drift("Fly App is not empty; refusing to delete untracked resources");
							yield* remove.app(deployment.app_name);
							if (Option.isSome(yield* observeApp)) return yield* pending();
						}
						// DNS and the complete Fly App are confirmed absent before hiding the board.
						yield* db.transaction(() =>
							Effect.gen(function* () {
								yield* db.select({ id: boards.id }).from(boards).where(eq(boards.id, operation.board_id)).for("update");
								const locked = yield* db
									.select({ id: boardOperations.id })
									.from(boardOperations)
									.where(
										and(
											eq(boardOperations.id, operation.id),
											eq(boardOperations.state, "running"),
											eq(boardOperations.lease_token, lease.leaseToken),
											eq(boardOperations.lease_owner, workerId),
											gt(boardOperations.lease_expires_at, sql`clock_timestamp()`),
										),
									)
									.for("update")
									.limit(1);
								if (!locked[0]) return yield* new LeaseLost({ operationId: operation.id });
								yield* db
									.update(boards)
									.set({ deleted_at: sql`clock_timestamp()` })
									.where(eq(boards.id, operation.board_id));
								yield* db.delete(boardRoutes).where(eq(boardRoutes.board_id, operation.board_id));
								yield* db.delete(boardPostgresSecrets).where(eq(boardPostgresSecrets.board_id, operation.board_id));
								yield* operations.succeed(operation.id, lease.leaseToken, workerId);
							}),
						);
						return "deleted" as const;
					});
					return yield* flow.pipe(
						Effect.catchTags({
							FlyApiError: (error) => Effect.fail(providerFailure("Fly", error)),
							CloudflareApiError: (error) => Effect.fail(providerFailure("Cloudflare", error)),
						}),
						Effect.catchTag("DeletionIssue", (error) =>
							Effect.gen(function* () {
								const countFailure = error.retry && error.code !== "deletion_pending";
								const nextFailureCount = operation.failure_count + (countFailure ? 1 : 0);
								if (error.retry && (!countFailure || nextFailureCount < settings.maxFailures)) {
									const now = yield* DateTime.now;
									yield* operations.requeue({
										...lease,
										availableAt: DateTime.toDateUtc(
											DateTime.addDuration(now, Math.max(60_000, settings.pollIntervalMs)),
										),
										errorCode: error.code,
										errorMessage: error.message,
										countFailure,
									});
									return "requeued" as const;
								}
								yield* operations.fail({
									...lease,
									errorCode: error.code,
									errorMessage: `${error.message}. Resolve the issue, then confirm deletion again to retry.`,
									countFailure,
								});
								return "blocked" as const;
							}),
						),
					);
				}),
		};
	});
export class BoardDeletionWorker extends Context.Service<
	BoardDeletionWorker,
	Effect.Success<ReturnType<typeof make>>
>()("comms/cloud/BoardDeletionWorker") {}
export const boardDeletionWorkerLayer = (settings: ProvisioningSettings) =>
	Layer.effect(BoardDeletionWorker, make(settings));
