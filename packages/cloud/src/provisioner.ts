import { Clock, Context, Data, Effect, Layer, Option, Random, Result } from "effect";
import { Boards } from "./boards.ts";
import { CloudflareDns } from "./cloudflare-dns.ts";
import {
	type Deployment,
	type DeploymentDrift,
	DeploymentFenceLost,
	type DeploymentState,
	InvalidDeploymentTransition,
} from "./deployment.ts";
import { Deployments, type DeploymentLease } from "./deployments.ts";
import { EdgeProbe } from "./edge-probe.ts";
import { EdgeNetworkingError, ensureEdgeNetworking } from "./edge-networking.ts";
import { type FlyApiError, FlyBoardApi } from "./fly-board-api.ts";
import type { FlyApp, FlyMachine, FlyVolume } from "./fly-model.ts";
import { machineConfig, machineMatches } from "./machine-spec.ts";
import { InvalidLeaseDuration, LeaseLost, type Operation, type ProviderMutation } from "./operation.ts";
import { Operations } from "./operations.ts";
import { deploymentSpec, type ProvisioningSettings } from "./provisioning-settings.ts";

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
	readonly code:
		| "storage_configuration_unsupported"
		| "provider_unavailable"
		| "provider_ambiguous"
		| "app_create_ambiguous"
		| "volume_create_ambiguous"
		| "machine_create_ambiguous"
		| "machine_start_ambiguous"
		| "edge_ip_ambiguous"
		| "edge_certificate_ambiguous"
		| "edge_a_record_ambiguous"
		| "edge_txt_record_ambiguous"
		| "provider_rejected"
		| "provider_drift"
		| "provider_observation_pending"
		| "retry_exhausted"
		| "edge_unavailable"
		| "provisioning_internal_error";
	readonly retriable: boolean;
	readonly message: string;
}> {}

export type ProvisioningOutcome = "succeeded" | "requeued" | "blocked" | "lost_lease";

const issue = (code: ProvisioningError["code"], retriable: boolean, message: string) =>
	new ProvisioningError({ code, retriable, message });
const rejected = (error: FlyApiError) =>
	error.reason === "status" &&
	error.status !== null &&
	error.status >= 400 &&
	error.status < 500 &&
	![404, 408, 409, 425, 429].includes(error.status);
const isAmbiguity = (code: string | null) => code === "provider_ambiguous" || code?.endsWith("_ambiguous") === true;
interface MutationJournal<E, R> {
	readonly pending: Set<ProviderMutation>;
	readonly mark: (mutation: ProviderMutation) => Effect.Effect<unknown, E, R>;
	readonly clear: (mutation: ProviderMutation) => Effect.Effect<unknown, E, R>;
}
const afterAppCreated: ReadonlyArray<DeploymentState> = [
	"app_created",
	"volume_created",
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
];
const afterVolumeCreated: ReadonlyArray<DeploymentState> = [
	"volume_created",
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
];
const afterMachineCreated: ReadonlyArray<DeploymentState> = [
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
];

const make = (settings: ProvisioningSettings) =>
	Effect.gen(function* () {
		const boards = yield* Boards;
		const deployments = yield* Deployments;
		const operations = yield* Operations;
		const fly = yield* FlyBoardApi;
		const dns = yield* CloudflareDns;
		const edge = yield* EdgeProbe;
		const observed = <A, R, E, R2>(effect: Effect.Effect<A, FlyApiError, R>, before: Effect.Effect<unknown, E, R2>) =>
			before.pipe(
				Effect.andThen(
					effect.pipe(
						Effect.mapError((error) =>
							error.reason === "decode"
								? issue("provider_drift", false, "Fly returned an unsupported response shape")
								: error.reason === "status" && error.status === 404
									? issue("provider_observation_pending", true, "Fly resource is not yet observable")
									: rejected(error)
										? issue("provider_rejected", false, "Fly rejected the observation")
										: issue("provider_unavailable", true, "Fly observation failed"),
						),
					),
				),
			);
		const assertApp = (app: FlyApp, deployment: Deployment) =>
			(app.id === deployment.app_id || deployment.app_id === null) &&
			app.name === deployment.app_name &&
			app.network === deployment.network_name &&
			app.organization.slug === settings.organization
				? Effect.succeed(app)
				: Effect.fail(issue("provider_drift", false, "Fly App identity drifted"));
		const assertVolume = (volume: FlyVolume, deployment: Deployment) =>
			volume.id === deployment.volume_id || deployment.volume_id === null
				? volume.name === deployment.volume_name &&
					volume.region === deployment.region &&
					volume.encrypted &&
					volume.fstype === "ext4" &&
					volume.size_gb >= deployment.volume_size_gb &&
					volume.auto_backup_enabled
					? Effect.succeed(volume)
					: Effect.fail(issue("provider_drift", false, "Fly Volume identity drifted"))
				: Effect.fail(issue("provider_drift", false, "Fly Volume ID drifted"));
		const assertMachine = (machine: FlyMachine, deployment: Deployment) =>
			(machine.id === deployment.machine_id || deployment.machine_id === null) && machineMatches(machine, deployment)
				? Effect.succeed(machine)
				: Effect.fail(issue("provider_drift", false, "Fly Machine identity drifted"));
		const ensureMachineStarted = <E, R, E2, R2>(
			deployment: Deployment,
			initial: FlyMachine,
			renewLease: Effect.Effect<unknown, E, R>,
			journal: MutationJournal<E2, R2>,
		) =>
			Effect.gen(function* () {
				if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
				let machine = initial;
				if (machine.state !== "started") {
					if (journal.pending.has("machine_start"))
						return yield* issue(
							"machine_start_ambiguous",
							true,
							"Fly Machine start remains unobservable; refusing to repeat it",
						);
					yield* renewLease;
					yield* journal.mark("machine_start");
					yield* renewLease;
					const started = yield* fly.startMachine(deployment.app_name, deployment.machine_id).pipe(Effect.result);
					if (Result.isFailure(started) && rejected(started.failure)) {
						yield* journal.clear("machine_start");
						return yield* issue("provider_rejected", false, "Fly rejected the Machine start");
					}
					let found = yield* observed(fly.getMachine(deployment.app_name, deployment.machine_id), renewLease);
					if (Option.isNone(found))
						return yield* issue("machine_start_ambiguous", true, "Fly Machine start is not observable");
					machine = yield* assertMachine(found.value, deployment);
					if (machine.state !== "started") {
						if (Result.isFailure(started)) {
							return yield* issue("machine_start_ambiguous", true, "Fly Machine start is not observable");
						}
						yield* observed(
							fly.waitMachine(deployment.app_name, deployment.machine_id, "started", machine.instance_id),
							renewLease,
						);
						found = yield* observed(fly.getMachine(deployment.app_name, deployment.machine_id), renewLease);
						if (Option.isNone(found))
							return yield* issue("machine_start_ambiguous", true, "Fly Machine disappeared after start");
						machine = yield* assertMachine(found.value, deployment);
					}
				}
				if (machine.state === "started" && journal.pending.has("machine_start")) yield* journal.clear("machine_start");
				if (machine.state !== "started" || !machine.checks?.some((check) => check.status === "passing"))
					return yield* issue("provider_observation_pending", true, "Fly Machine health check is not passing");
				return machine;
			});
		const verifyRecordedResources = <E, R, E2, R2>(
			deployment: Deployment,
			renewLease: Effect.Effect<unknown, E, R>,
			journal: MutationJournal<E2, R2>,
		) =>
			Effect.gen(function* () {
				if (deployment.app_id !== null || afterAppCreated.includes(deployment.state)) {
					const app = yield* observed(fly.getApp(deployment.app_name), renewLease);
					if (Option.isNone(app)) return yield* issue("provider_drift", false, "Recorded Fly App is missing");
					yield* assertApp(app.value, deployment);
					if (journal.pending.has("app_create")) yield* journal.clear("app_create");
				}
				if (deployment.volume_id !== null || afterVolumeCreated.includes(deployment.state)) {
					if (!deployment.volume_id) return yield* issue("provider_drift", false, "Fly Volume ID is missing");
					const matching = (yield* observed(fly.listVolumes(deployment.app_name), renewLease)).filter(
						(volume) => volume.name === deployment.volume_name && volume.region === deployment.region,
					);
					if (matching.length > 1)
						return yield* issue("provider_drift", false, "Multiple Fly Volumes match this deployment");
					if (matching.length === 0)
						return yield* issue(
							deployment.state === "volume_created" ? "provider_observation_pending" : "provider_drift",
							deployment.state === "volume_created",
							"Recorded Fly Volume is not observable",
						);
					const volume = yield* assertVolume(matching[0]!, deployment);
					if (journal.pending.has("volume_create")) yield* journal.clear("volume_create");
					if (volume.state !== "created")
						return yield* issue("provider_observation_pending", true, "Recorded Fly Volume is not ready");
					if (deployment.machine_id !== null && volume.attached_machine_id !== deployment.machine_id)
						return yield* issue("provider_drift", false, "Fly Volume attachment drifted");
				}
				if (deployment.machine_id !== null || afterMachineCreated.includes(deployment.state)) {
					if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
					const serving = (yield* observed(fly.listMachines(deployment.app_name), renewLease)).filter(
						(machine) => machine.config.services.length > 0,
					);
					if (serving.length > 1)
						return yield* issue("provider_drift", false, "Multiple service-bearing Fly Machines exist in this App");
					const matching = serving.filter(
						(machine) =>
							machine.name === deployment.machine_name &&
							machine.config.metadata["chirp.deployment_id"] === deployment.board_id,
					);
					if (matching.length > 1)
						return yield* issue("provider_drift", false, "Multiple Fly Machines match this deployment");
					if (matching.length === 0)
						return yield* issue(
							deployment.state === "machine_created" ? "provider_observation_pending" : "provider_drift",
							deployment.state === "machine_created",
							"Recorded Fly Machine is not observable",
						);
					const machine = yield* assertMachine(matching[0]!, deployment);
					if (journal.pending.has("machine_create")) yield* journal.clear("machine_create");
					if (deployment.state !== "machine_created") {
						yield* ensureMachineStarted(deployment, machine, renewLease, journal);
						yield* ensureEdgeNetworking(deployment.app_name, deployment.hostname, renewLease, {
							isPending: (mutation) => journal.pending.has(`edge_${mutation}` as ProviderMutation),
							mark: (mutation) => journal.mark(`edge_${mutation}` as ProviderMutation),
							clear: (mutation) => journal.clear(`edge_${mutation}` as ProviderMutation),
						}).pipe(
							Effect.provideService(FlyBoardApi, fly),
							Effect.provideService(CloudflareDns, dns),
							Effect.catchIf(
								(error): error is EdgeNetworkingError => error instanceof EdgeNetworkingError,
								(error) =>
									Effect.fail(
										issue(
											error.reason === "ambiguous" && error.mutation
												? `edge_${error.mutation}_ambiguous`
												: error.reason === "conflict"
													? "provider_drift"
													: error.reason === "rejected"
														? "provider_rejected"
														: error.reason === "unsupported"
															? "provider_drift"
															: error.reason === "unavailable"
																? "provider_unavailable"
																: "provider_observation_pending",
											error.reason === "pending" || error.reason === "unavailable" || error.reason === "ambiguous",
											`Edge networking ${error.reason}`,
										),
									),
							),
						);
					}
				}
			});
		return {
			run: (operation: Operation, workerId: string) =>
				Effect.gen(function* () {
					if (operation.kind !== "provision" || !operation.lease_token || operation.lease_owner !== workerId)
						return "lost_lease" as const;
					const lease: DeploymentLease = {
						operationId: operation.id,
						leaseToken: operation.lease_token,
						workerId,
					};
					const deadline = operation.created_at.getTime() + settings.maxOperationAgeMs;
					const ensureWithinLifetime = Clock.currentTimeMillis.pipe(
						Effect.flatMap((now) =>
							now < deadline
								? Effect.void
								: Effect.fail(issue("retry_exhausted", true, "Provisioning lifetime reached")),
						),
					);
					const pending = new Set(operation.ambiguous_mutations);
					const journal = {
						pending,
						mark: (mutation: ProviderMutation) =>
							operations
								.markAmbiguousMutation({
									id: operation.id,
									leaseToken: lease.leaseToken,
									workerId,
									mutation,
								})
								.pipe(Effect.tap(() => Effect.sync(() => pending.add(mutation)))),
						clear: (mutation: ProviderMutation) =>
							operations
								.clearAmbiguousMutation({
									id: operation.id,
									leaseToken: lease.leaseToken,
									workerId,
									mutation,
								})
								.pipe(Effect.tap(() => Effect.sync(() => pending.delete(mutation)))),
					};
					const renewLease = operations.renew({
						id: operation.id,
						leaseToken: lease.leaseToken,
						workerId,
						leaseMilliseconds: 90_000,
					});
					const beforeProvider = ensureWithinLifetime.pipe(
						Effect.andThen(renewLease),
						Effect.andThen(ensureWithinLifetime),
					);
					const settle = (error: ProvisioningError) =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const observationWait = error.code === "provider_observation_pending";
							const ambiguityWait = isAmbiguity(error.code) || pending.size > 0;
							const waitsWithoutFailure = observationWait || ambiguityWait || error.code === "retry_exhausted";
							const countFailure = error.retriable && !waitsWithoutFailure;
							const nextFailureCount = operation.failure_count + (countFailure ? 1 : 0);
							const ageExceeded = now >= deadline;
							if (error.retriable && !ageExceeded && (!countFailure || nextFailureCount < settings.maxFailures)) {
								let delay: number;
								if (ambiguityWait) delay = Math.max(60_000, settings.pollIntervalMs);
								else if (observationWait) delay = settings.pollIntervalMs;
								else {
									const ceiling = Math.min(300_000, 5_000 * 2 ** Math.max(0, nextFailureCount - 1));
									delay = Math.floor(ceiling / 2 + (yield* Random.next) * (ceiling / 2));
								}
								yield* operations.requeue({
									id: operation.id,
									leaseToken: lease.leaseToken,
									workerId,
									availableAt: new Date(Math.min(now + delay, deadline)),
									errorCode: error.code,
									errorMessage: error.message,
									countFailure,
								});
								return "requeued" as const;
							}
							const exhausted = error.retriable;
							yield* deployments.block({
								...lease,
								errorCode: exhausted ? "retry_exhausted" : error.code,
								errorMessage: exhausted
									? ageExceeded
										? `Provisioning lifetime reached: ${error.code}. ${error.message}`
										: `Provisioning failure limit reached: ${error.code}. ${error.message}`
									: error.message,
								countFailure,
							});
							return "blocked" as const;
						});
					const flow = Effect.gen(function* () {
						const board = yield* boards.getById(operation.board_id).pipe(
							Effect.flatMap(
								Option.match({
									onNone: () => Effect.die("Provision operation references no board"),
									onSome: Effect.succeed,
								}),
							),
						);
						let deployment = yield* deployments.ensure({
							...lease,
							spec: deploymentSpec(board.slug, settings),
						});
						if (
							deployment.state !== "provisioned" &&
							(operation.failure_count >= settings.maxFailures || (yield* Clock.currentTimeMillis) >= deadline)
						) {
							yield* deployments.block({
								...lease,
								errorCode: "retry_exhausted",
								errorMessage: "Provisioning retry budget was already exhausted before provider work",
							});
							return "blocked" as const;
						}
						const finalizationOnly = deployment.state === "provisioned" && pending.size === 0;
						const advance = (
							next: DeploymentState,
							changes: {
								readonly appId?: string;
								readonly volumeId?: string;
								readonly machineId?: string;
								readonly resolvedMutation?: ProviderMutation;
							} = {},
						) => {
							const resolvedMutation = changes.resolvedMutation;
							return deployments
								.transition({
									...lease,
									expectedCheckpoint: deployment.state,
									expectedRowVersion: deployment.row_version,
									next,
									...changes,
								})
								.pipe(
									Effect.tap(() =>
										resolvedMutation === undefined ? Effect.void : Effect.sync(() => pending.delete(resolvedMutation)),
									),
								);
						};
						while (true) {
							yield* renewLease;
							if (deployment.state === "blocked")
								return yield* issue("provider_drift", false, "Blocked deployment requires an operator retry");
							if (deployment.state === "provisioned" && pending.size === 0) {
								if (!finalizationOnly) yield* ensureWithinLifetime;
								yield* operations.succeed(operation.id, lease.leaseToken, workerId);
								return "succeeded" as const;
							}
							yield* ensureWithinLifetime;
							yield* verifyRecordedResources(deployment, beforeProvider, journal);
							if (deployment.state === "provisioned") {
								if (pending.size > 0)
									return yield* issue(
										"provider_observation_pending",
										true,
										"Provisioning completed with unresolved provider mutations",
									);
								yield* ensureWithinLifetime;
								yield* operations.succeed(operation.id, lease.leaseToken, workerId);
								return "succeeded" as const;
							}
							switch (deployment.state) {
								case "requested": {
									if (deployment.storage_engine !== "sqlite")
										return yield* issue(
											"storage_configuration_unsupported",
											false,
											"External database verification is not implemented",
										);
									deployment = yield* advance("storage_configuration_verified");
									break;
								}
								case "storage_configuration_verified": {
									let app = yield* observed(fly.getApp(deployment.app_name), beforeProvider);
									let creation: Result.Result<void, FlyApiError> | undefined;
									if (Option.isNone(app)) {
										if (pending.has("app_create"))
											return yield* issue(
												"app_create_ambiguous",
												true,
												"Fly App creation remains unobservable; refusing to create a duplicate",
											);
										yield* beforeProvider;
										yield* journal.mark("app_create");
										yield* beforeProvider;
										creation = yield* fly
											.createApp({
												name: deployment.app_name,
												organization: settings.organization,
												network: deployment.network_name,
											})
											.pipe(Effect.result);
										if (Result.isFailure(creation) && rejected(creation.failure)) {
											yield* journal.clear("app_create");
											return yield* issue("provider_rejected", false, "Fly rejected the App creation");
										}
										app = yield* observed(fly.getApp(deployment.app_name), beforeProvider);
									}
									if (Option.isNone(app)) {
										return yield* issue("app_create_ambiguous", true, "Fly App creation is not yet observable");
									}
									yield* assertApp(app.value, deployment);
									deployment = yield* advance("app_created", {
										appId: app.value.id,
										resolvedMutation: "app_create",
									});
									break;
								}
								case "app_created": {
									const listed = yield* observed(fly.listVolumes(deployment.app_name), beforeProvider);
									let matching = listed.filter(
										(volume) => volume.name === deployment.volume_name && volume.region === deployment.region,
									);
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Volumes match this deployment");
									if (matching.length === 0 && pending.has("volume_create"))
										return yield* issue(
											"volume_create_ambiguous",
											true,
											"Fly Volume creation remains unobservable; refusing to create a duplicate",
										);
									if (matching.length === 0) {
										yield* beforeProvider;
										yield* journal.mark("volume_create");
										yield* beforeProvider;
										const created = yield* fly
											.createVolume({
												appName: deployment.app_name,
												name: deployment.volume_name,
												region: deployment.region,
												sizeGb: deployment.volume_size_gb,
											})
											.pipe(Effect.result);
										if (Result.isFailure(created) && rejected(created.failure)) {
											yield* journal.clear("volume_create");
											return yield* issue("provider_rejected", false, "Fly rejected the Volume creation");
										}
										matching = Result.isSuccess(created)
											? [created.success]
											: (yield* observed(fly.listVolumes(deployment.app_name), beforeProvider)).filter(
													(volume) => volume.name === deployment.volume_name && volume.region === deployment.region,
												);
									}
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Volumes match this deployment");
									if (matching.length !== 1) {
										return yield* issue(
											"volume_create_ambiguous",
											true,
											"Fly Volume creation is not uniquely observable",
										);
									}
									const volume = yield* assertVolume(matching[0]!, deployment);
									deployment = yield* advance("volume_created", {
										volumeId: volume.id,
										resolvedMutation: "volume_create",
									});
									break;
								}
								case "volume_created": {
									if (!deployment.volume_id) return yield* issue("provider_drift", false, "Fly Volume ID is missing");
									const found = yield* observed(
										fly.getVolume(deployment.app_name, deployment.volume_id),
										beforeProvider,
									);
									if (Option.isNone(found))
										return yield* issue("provider_observation_pending", true, "Fly Volume is not observable");
									const volume = yield* assertVolume(found.value, deployment);
									if (["creating", "pending", "extending"].includes(volume.state))
										return yield* issue("provider_observation_pending", true, "Fly Volume is not ready");
									if (volume.state !== "created")
										return yield* issue("provider_drift", false, "Fly Volume entered an unsupported state");
									const serving = (yield* observed(fly.listMachines(deployment.app_name), beforeProvider)).filter(
										(machine) => machine.config.services.length > 0,
									);
									if (serving.length > 1)
										return yield* issue(
											"provider_drift",
											false,
											"Multiple service-bearing Fly Machines exist in this App",
										);
									let matching = serving.filter(
										(machine) =>
											machine.name === deployment.machine_name &&
											machine.config.metadata["chirp.deployment_id"] === deployment.board_id,
									);
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Machines match this deployment");
									if (serving.length === 1 && matching.length === 0)
										return yield* issue("provider_drift", false, "An untracked service-bearing Fly Machine exists");
									if (matching.length === 0 && pending.has("machine_create"))
										return yield* issue(
											"machine_create_ambiguous",
											true,
											"Fly Machine creation remains unobservable; refusing to create a duplicate",
										);
									if (matching.length === 0) {
										yield* beforeProvider;
										yield* journal.mark("machine_create");
										yield* beforeProvider;
										const created = yield* fly
											.createMachine({
												appName: deployment.app_name,
												name: deployment.machine_name,
												region: deployment.region,
												config: machineConfig(deployment),
											})
											.pipe(Effect.result);
										if (Result.isFailure(created) && rejected(created.failure)) {
											yield* journal.clear("machine_create");
											return yield* issue("provider_rejected", false, "Fly rejected the Machine creation");
										}
										matching = Result.isSuccess(created)
											? [created.success]
											: (yield* observed(fly.listMachines(deployment.app_name), beforeProvider))
													.filter((machine) => machine.config.services.length > 0)
													.filter(
														(machine) =>
															machine.name === deployment.machine_name &&
															machine.config.metadata["chirp.deployment_id"] === deployment.board_id,
													);
									}
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Machines match this deployment");
									if (matching.length !== 1) {
										return yield* issue(
											"machine_create_ambiguous",
											true,
											"Fly Machine creation is not uniquely observable",
										);
									}
									const machine = yield* assertMachine(matching[0]!, deployment);
									deployment = yield* advance("machine_created", {
										machineId: machine.id,
										resolvedMutation: "machine_create",
									});
									break;
								}
								case "machine_created": {
									if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
									const found = yield* observed(
										fly.getMachine(deployment.app_name, deployment.machine_id),
										beforeProvider,
									);
									if (Option.isNone(found))
										return yield* issue("provider_observation_pending", true, "Fly Machine is not observable");
									yield* ensureMachineStarted(
										deployment,
										yield* assertMachine(found.value, deployment),
										beforeProvider,
										journal,
									);
									deployment = yield* advance("machine_started");
									break;
								}
								case "machine_started": {
									yield* ensureWithinLifetime;
									yield* deployments.publishRoute({ ...lease, expectedRowVersion: deployment.row_version });
									yield* beforeProvider;
									yield* edge
										.health(deployment.hostname)
										.pipe(Effect.mapError(() => issue("edge_unavailable", true, "Board health is not reachable")));
									deployment = yield* advance("edge_reachable");
									break;
								}
								case "edge_reachable": {
									yield* beforeProvider;
									yield* edge
										.childRoute(deployment.hostname)
										.pipe(Effect.mapError(() => issue("edge_unavailable", true, "Board child route is not reachable")));
									deployment = yield* advance("child_route_observed");
									break;
								}
								case "child_route_observed": {
									yield* ensureWithinLifetime;
									deployment = yield* advance("provisioned");
									break;
								}
							}
						}
					});
					return yield* flow.pipe(
						Effect.catchTags({
							DeploymentDrift: (error: DeploymentDrift) =>
								deployments
									.block({
										...lease,
										errorCode: "deployment_drift",
										errorMessage: `Immutable deployment field drifted: ${error.field}`,
									})
									.pipe(Effect.as<ProvisioningOutcome>("blocked")),
							ProvisioningError: settle,
						}),
						Effect.catch((error) =>
							error instanceof LeaseLost || error instanceof DeploymentFenceLost
								? Effect.succeed("lost_lease" as const)
								: settle(
										issue(
											"provisioning_internal_error",
											!(error instanceof InvalidLeaseDuration || error instanceof InvalidDeploymentTransition),
											"Provisioning persistence or state transition failed",
										),
									),
						),
					);
				}),
		};
	});

export class Provisioner extends Context.Service<Provisioner, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/Provisioner",
) {}
export const provisionerLayer = (settings: ProvisioningSettings) => Layer.effect(Provisioner, make(settings));
