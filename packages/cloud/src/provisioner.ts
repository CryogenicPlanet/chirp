import { Context, Data, DateTime, Effect, Layer, Option, Random, Result } from "effect";
import { Boards } from "./boards.ts";
import { CloudflareDns } from "./cloudflare-dns.ts";
import type { Deployment, DeploymentDrift, DeploymentState } from "./deployment.ts";
import { Deployments, type DeploymentLease } from "./deployments.ts";
import { EdgeProbe } from "./edge-probe.ts";
import { EdgeNetworkingError, ensureEdgeNetworking } from "./edge-networking.ts";
import { type FlyApiError, FlyBoardApi } from "./fly-board-api.ts";
import type { FlyApp, FlyMachine, FlyVolume } from "./fly-model.ts";
import { machineConfig, machineMatches } from "./machine-spec.ts";
import type { Operation } from "./operation.ts";
import { Operations } from "./operations.ts";
import { deploymentSpec, type ProvisioningSettings } from "./provisioning-settings.ts";

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
	readonly code:
		| "storage_configuration_unsupported"
		| "provider_unavailable"
		| "provider_ambiguous"
		| "provider_rejected"
		| "provider_drift"
		| "provider_observation_pending"
		| "retry_exhausted"
		| "edge_unavailable";
	readonly retriable: boolean;
	readonly message: string;
}> {}

export type ProvisioningOutcome = "succeeded" | "requeued" | "blocked";

const maxAttempts = 10;

const issue = (code: ProvisioningError["code"], retriable: boolean, message: string) =>
	new ProvisioningError({ code, retriable, message });
const rejected = (error: FlyApiError) =>
	error.reason === "status" &&
	error.status !== null &&
	error.status >= 400 &&
	error.status < 500 &&
	![408, 409, 425, 429].includes(error.status);
const mutationFailure = (error: FlyApiError, message: string) =>
	rejected(error) ? issue("provider_rejected", false, message) : issue("provider_ambiguous", true, message);
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
		const observed = <A, R>(effect: Effect.Effect<A, FlyApiError, R>) =>
			effect.pipe(
				Effect.mapError((error) =>
					rejected(error)
						? issue("provider_rejected", false, "Fly rejected the observation")
						: issue("provider_unavailable", true, "Fly observation failed"),
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
		const ensureMachineStarted = <E, R>(
			deployment: Deployment,
			initial: FlyMachine,
			renewLease: Effect.Effect<unknown, E, R>,
		) =>
			Effect.gen(function* () {
				if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
				let machine = initial;
				if (machine.state !== "started") {
					yield* renewLease;
					const started = yield* fly.startMachine(deployment.app_name, deployment.machine_id).pipe(Effect.result);
					let found = yield* observed(fly.getMachine(deployment.app_name, deployment.machine_id));
					if (Option.isNone(found))
						return yield* issue("provider_observation_pending", true, "Fly Machine start is not observable");
					machine = yield* assertMachine(found.value, deployment);
					if (machine.state !== "started") {
						if (Result.isFailure(started))
							return yield* mutationFailure(started.failure, "Fly rejected the Machine start");
						yield* observed(
							fly.waitMachine(deployment.app_name, deployment.machine_id, "started", machine.instance_id),
						);
						found = yield* observed(fly.getMachine(deployment.app_name, deployment.machine_id));
						if (Option.isNone(found))
							return yield* issue("provider_observation_pending", true, "Fly Machine disappeared after start");
						machine = yield* assertMachine(found.value, deployment);
					}
				}
				if (machine.state !== "started" || !machine.checks?.some((check) => check.status === "passing"))
					return yield* issue("provider_observation_pending", true, "Fly Machine health check is not passing");
				return machine;
			});
		const verifyRecordedResources = <E, R>(deployment: Deployment, renewLease: Effect.Effect<unknown, E, R>) =>
			Effect.gen(function* () {
				if (deployment.app_id !== null || afterAppCreated.includes(deployment.state)) {
					const app = yield* observed(fly.getApp(deployment.app_name));
					if (Option.isNone(app)) return yield* issue("provider_drift", false, "Recorded Fly App is missing");
					yield* assertApp(app.value, deployment);
				}
				if (deployment.volume_id !== null || afterVolumeCreated.includes(deployment.state)) {
					if (!deployment.volume_id) return yield* issue("provider_drift", false, "Fly Volume ID is missing");
					const matching = (yield* observed(fly.listVolumes(deployment.app_name))).filter(
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
					if (volume.state !== "created")
						return yield* issue("provider_observation_pending", true, "Recorded Fly Volume is not ready");
					if (deployment.machine_id !== null && volume.attached_machine_id !== deployment.machine_id)
						return yield* issue("provider_drift", false, "Fly Volume attachment drifted");
				}
				if (deployment.machine_id !== null || afterMachineCreated.includes(deployment.state)) {
					if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
					const matching = (yield* observed(fly.listMachines(deployment.app_name))).filter(
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
					if (deployment.state !== "machine_created") {
						yield* ensureMachineStarted(deployment, machine, renewLease);
						yield* ensureEdgeNetworking(deployment.app_name, deployment.hostname, renewLease).pipe(
							Effect.provideService(FlyBoardApi, fly),
							Effect.provideService(CloudflareDns, dns),
							Effect.catchIf(
								(error): error is EdgeNetworkingError => error instanceof EdgeNetworkingError,
								(error) =>
									Effect.fail(
										issue(
											error.reason === "conflict"
												? "provider_drift"
												: error.reason === "rejected"
													? "provider_rejected"
													: "provider_observation_pending",
											error.reason === "pending" || error.reason === "unavailable",
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
					if (operation.kind !== "provision")
						return yield* issue("provider_drift", false, "Provisioner received a non-provision operation");
					if (!operation.lease_token || operation.lease_owner !== workerId)
						return yield* issue("provider_drift", false, "Provisioner received an unowned operation");
					const lease: DeploymentLease = {
						operationId: operation.id,
						leaseToken: operation.lease_token,
						workerId,
					};
					const renewLease = operations.renew({
						id: operation.id,
						leaseToken: lease.leaseToken,
						workerId,
						leaseMilliseconds: 90_000,
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
						const advance = (
							next: DeploymentState,
							changes: {
								readonly appId?: string;
								readonly volumeId?: string;
								readonly machineId?: string;
							} = {},
						) =>
							deployments.transition({
								...lease,
								expectedCheckpoint: deployment.state,
								expectedRowVersion: deployment.row_version,
								next,
								...changes,
							});
						while (true) {
							yield* renewLease;
							if (deployment.state === "provisioned") {
								yield* operations.succeed(operation.id, lease.leaseToken, workerId);
								return "succeeded" as const;
							}
							if (deployment.state === "blocked")
								return yield* issue("provider_drift", false, "Blocked deployment requires an operator retry");
							if (operation.attempt > maxAttempts)
								return yield* issue(
									"retry_exhausted",
									false,
									"Provisioning attempt limit reached after lease recovery",
								);
							yield* verifyRecordedResources(deployment, renewLease);
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
									let app = yield* observed(fly.getApp(deployment.app_name));
									let creation: Result.Result<void, FlyApiError> | undefined;
									if (Option.isNone(app)) {
										yield* renewLease;
										creation = yield* fly
											.createApp({
												name: deployment.app_name,
												organization: settings.organization,
												network: deployment.network_name,
											})
											.pipe(Effect.result);
										app = yield* observed(fly.getApp(deployment.app_name));
									}
									if (Option.isNone(app)) {
										if (creation && Result.isFailure(creation))
											return yield* mutationFailure(creation.failure, "Fly rejected the App creation");
										return yield* issue("provider_ambiguous", true, "Fly App creation is not yet observable");
									}
									yield* assertApp(app.value, deployment);
									deployment = yield* advance("app_created", { appId: app.value.id });
									break;
								}
								case "app_created": {
									const listed = yield* observed(fly.listVolumes(deployment.app_name));
									let matching = listed.filter(
										(volume) => volume.name === deployment.volume_name && volume.region === deployment.region,
									);
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Volumes match this deployment");
									let creationFailure: FlyApiError | undefined;
									if (matching.length === 0) {
										yield* renewLease;
										const created = yield* fly
											.createVolume({
												appName: deployment.app_name,
												name: deployment.volume_name,
												region: deployment.region,
												sizeGb: deployment.volume_size_gb,
											})
											.pipe(Effect.result);
										matching = Result.isSuccess(created)
											? [created.success]
											: (yield* observed(fly.listVolumes(deployment.app_name))).filter(
													(volume) => volume.name === deployment.volume_name && volume.region === deployment.region,
												);
										if (Result.isFailure(created)) creationFailure = created.failure;
									}
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Volumes match this deployment");
									if (matching.length !== 1) {
										if (matching.length === 0 && creationFailure)
											return yield* mutationFailure(creationFailure, "Fly rejected the Volume creation");
										return yield* issue("provider_ambiguous", true, "Fly Volume creation is not uniquely observable");
									}
									const volume = yield* assertVolume(matching[0]!, deployment);
									deployment = yield* advance("volume_created", { volumeId: volume.id });
									break;
								}
								case "volume_created": {
									if (!deployment.volume_id) return yield* issue("provider_drift", false, "Fly Volume ID is missing");
									const found = yield* observed(fly.getVolume(deployment.app_name, deployment.volume_id));
									if (Option.isNone(found))
										return yield* issue("provider_observation_pending", true, "Fly Volume is not observable");
									const volume = yield* assertVolume(found.value, deployment);
									if (["creating", "pending", "extending"].includes(volume.state))
										return yield* issue("provider_observation_pending", true, "Fly Volume is not ready");
									if (volume.state !== "created")
										return yield* issue("provider_drift", false, "Fly Volume entered an unsupported state");
									const listed = yield* observed(fly.listMachines(deployment.app_name));
									let matching = listed.filter(
										(machine) =>
											machine.name === deployment.machine_name &&
											machine.config.metadata["chirp.deployment_id"] === deployment.board_id,
									);
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Machines match this deployment");
									let creationFailure: FlyApiError | undefined;
									if (matching.length === 0) {
										yield* renewLease;
										const created = yield* fly
											.createMachine({
												appName: deployment.app_name,
												name: deployment.machine_name,
												region: deployment.region,
												config: machineConfig(deployment),
											})
											.pipe(Effect.result);
										matching = Result.isSuccess(created)
											? [created.success]
											: (yield* observed(fly.listMachines(deployment.app_name))).filter(
													(machine) =>
														machine.name === deployment.machine_name &&
														machine.config.metadata["chirp.deployment_id"] === deployment.board_id,
												);
										if (Result.isFailure(created)) creationFailure = created.failure;
									}
									if (matching.length > 1)
										return yield* issue("provider_drift", false, "Multiple Fly Machines match this deployment");
									if (matching.length !== 1) {
										if (matching.length === 0 && creationFailure)
											return yield* mutationFailure(creationFailure, "Fly rejected the Machine creation");
										return yield* issue("provider_ambiguous", true, "Fly Machine creation is not uniquely observable");
									}
									const machine = yield* assertMachine(matching[0]!, deployment);
									deployment = yield* advance("machine_created", {
										machineId: machine.id,
									});
									break;
								}
								case "machine_created": {
									if (!deployment.machine_id) return yield* issue("provider_drift", false, "Fly Machine ID is missing");
									const found = yield* observed(fly.getMachine(deployment.app_name, deployment.machine_id));
									if (Option.isNone(found))
										return yield* issue("provider_observation_pending", true, "Fly Machine is not observable");
									const machine = yield* ensureMachineStarted(
										deployment,
										yield* assertMachine(found.value, deployment),
										renewLease,
									);
									deployment = yield* advance("machine_started");
									break;
								}
								case "machine_started": {
									yield* deployments.publishRoute({ ...lease, expectedRowVersion: deployment.row_version });
									yield* edge
										.health(deployment.hostname)
										.pipe(Effect.mapError(() => issue("edge_unavailable", true, "Board health is not reachable")));
									deployment = yield* advance("edge_reachable");
									break;
								}
								case "edge_reachable": {
									yield* edge
										.childRoute(deployment.hostname)
										.pipe(Effect.mapError(() => issue("edge_unavailable", true, "Board child route is not reachable")));
									deployment = yield* advance("child_route_observed");
									break;
								}
								case "child_route_observed": {
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
							ProvisioningError: (error) =>
								Effect.gen(function* () {
									if (error.retriable && operation.attempt < maxAttempts) {
										const now = yield* DateTime.now;
										const ceiling = Math.min(300_000, 5_000 * 2 ** (operation.attempt - 1));
										const delay = Math.floor(ceiling / 2 + ((yield* Random.next) * ceiling) / 2);
										yield* operations.requeue({
											id: operation.id,
											leaseToken: lease.leaseToken,
											workerId,
											availableAt: DateTime.toDateUtc(DateTime.addDuration(now, delay)),
											errorCode: error.code,
											errorMessage: error.message,
										});
										return "requeued" as const;
									}
									yield* deployments.block({
										...lease,
										errorCode: error.retriable ? "retry_exhausted" : error.code,
										errorMessage: error.retriable
											? `Provisioning attempt limit reached: ${error.code}. ${error.message}`
											: error.message,
									});
									return "blocked" as const;
								}),
						}),
					);
				}),
		};
	});

export class Provisioner extends Context.Service<Provisioner, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/Provisioner",
) {}
export const provisionerLayer = (settings: ProvisioningSettings) => Layer.effect(Provisioner, make(settings));
