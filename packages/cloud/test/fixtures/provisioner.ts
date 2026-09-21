import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CloudflareDns } from "../../src/cloudflare-dns.ts";
import type { DeploymentState } from "../../src/deployment.ts";
import { EdgeProbe, EdgeProbeError } from "../../src/edge-probe.ts";
import { ImageRegistry, ImageRegistryError } from "../../src/image-registry.ts";
import type { ReleaseChannel } from "../../src/board.ts";
import { FlyApiError, FlyBoardApi } from "../../src/fly-board-api.ts";
import type { FlyApp, FlyMachine, FlyVolume } from "../../src/fly-model.ts";
import { Operations } from "../../src/operations.ts";
import { provisionerLayer } from "../../src/provisioner.ts";
import type { ProvisioningSettings } from "../../src/provisioning-settings.ts";
import { makeNetworking } from "./edge-networking.ts";

// The digest a board's release channel resolves to in these tests.
export const imageRef = `registry.example/chirp@sha256:${"a".repeat(64)}`;

export const settings: ProvisioningSettings = {
	organization: "chirp",
	region: "sjc",
	boardsDomain: "boards.chirp.wiki",
	volumeSizeGb: 1,
	maxFailures: 10,
	maxOperationAgeMs: 86_400_000,
	pollIntervalMs: 30_000,
};

export const request = {
	owner_id: "user-1",
	name: "Managed board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "provision-fly-1",
} as const;
export const checkpoints: ReadonlyArray<Exclude<DeploymentState, "blocked">> = [
	"requested",
	"storage_configuration_verified",
	"app_created",
	"volume_created",
	"machine_created",
	"machine_started",
	"edge_reachable",
	"child_route_observed",
	"provisioned",
];

export const appFor = (slug: string): FlyApp => ({
	id: "app-id",
	name: `chirp-${slug}`,
	network: `chirp-${slug}`,
	organization: { slug: settings.organization },
});

export const volumeFor = (): FlyVolume => ({
	id: "volume-id",
	name: "chirp_data",
	state: "created",
	region: settings.region,
	encrypted: true,
	size_gb: settings.volumeSizeGb,
	auto_backup_enabled: true,
	fstype: "ext4",
});

const flyUnavailable = (operation: string) => new FlyApiError({ operation, reason: "transport", status: null });

export const makeFakeProvider = () => {
	const networking = makeNetworking();
	let app: FlyApp | undefined;
	const volumes: FlyVolume[] = [];
	const machines: FlyMachine[] = [];
	let hideAppReads = 0;
	let rejectAppRead = false;
	let decodeAppRead = false;
	let hideVolumes = false;
	let failListVolumes = false;
	let failGetVolume = false;
	let failListMachines = false;
	let failGetMachine = false;
	let failCreateApp = false;
	let failCreateAppBeforeMutation = false;
	let rejectCreateApp = false;
	let failAppReadAfterRejectedCreate = false;
	let failAppRead = false;
	let createAppDelayMs = 0;
	let failCreateVolume = false;
	let failListVolumesAfterCreate = false;
	let failCreateVolumeBeforeMutation = false;
	let failCreateMachine = false;
	let failCreateMachineBeforeMutation = false;
	let failStartMachineBeforeMutation = false;
	let startPreconditionFailures = 0;
	let failHealth = false;
	let failChildRoute = false;
	const calls = {
		createApp: 0,
		createVolume: 0,
		createMachine: 0,
		startMachine: 0,
	};
	const fake = {
		...networking.fly,
		getApp: (name: string) =>
			Effect.gen(function* () {
				if (failAppRead) {
					failAppRead = false;
					return yield* flyUnavailable("get_app");
				}
				if (decodeAppRead) {
					decodeAppRead = false;
					return yield* new FlyApiError({ operation: "get_app", reason: "decode", status: 200 });
				}
				if (rejectAppRead) {
					rejectAppRead = false;
					return yield* new FlyApiError({ operation: "get_app", reason: "status", status: 401 });
				}
				if (app?.name !== name) return Option.none<FlyApp>();
				if (hideAppReads > 0) {
					hideAppReads -= 1;
					return Option.none<FlyApp>();
				}
				return Option.some(app);
			}),
		createApp: (input: { readonly name: string; readonly organization: string; readonly network: string }) =>
			Effect.gen(function* () {
				calls.createApp += 1;
				if (createAppDelayMs > 0) yield* Effect.sleep(createAppDelayMs);
				if (failCreateAppBeforeMutation) {
					failCreateAppBeforeMutation = false;
					return yield* new FlyApiError({ operation: "create_app", reason: "transport", status: null });
				}
				if (rejectCreateApp) {
					rejectCreateApp = false;
					if (failAppReadAfterRejectedCreate) {
						failAppReadAfterRejectedCreate = false;
						failAppRead = true;
					}
					return yield* new FlyApiError({ operation: "create_app", reason: "status", status: 400 });
				}
				app = { id: "app-id", name: input.name, network: input.network, organization: { slug: input.organization } };
				if (failCreateApp) {
					failCreateApp = false;
					return yield* Effect.fail(flyUnavailable("create_app"));
				}
			}).pipe(Effect.asVoid),
		listVolumes: (_name: string) =>
			Effect.gen(function* () {
				if (failListVolumes) {
					failListVolumes = false;
					return yield* Effect.fail(flyUnavailable("list_volumes"));
				}
				return hideVolumes ? [] : volumes;
			}),
		getVolume: (_name: string, id: string) =>
			Effect.gen(function* () {
				if (failGetVolume) {
					failGetVolume = false;
					return yield* Effect.fail(flyUnavailable("get_volume"));
				}
				return Option.fromNullishOr(volumes.find((volume) => volume.id === id));
			}),
		createVolume: (input: {
			readonly appName: string;
			readonly name: string;
			readonly region: string;
			readonly sizeGb: number;
		}) =>
			Effect.gen(function* () {
				calls.createVolume += 1;
				if (failCreateVolumeBeforeMutation) {
					failCreateVolumeBeforeMutation = false;
					return yield* Effect.fail(flyUnavailable("create_volume"));
				}
				const volume = { ...volumeFor(), name: input.name };
				volumes.push(volume);
				// Fly echoes the create request before the Volume is materialized: the response carries
				// no fstype, and only a later observation reports it.
				const echoed = { ...volume, fstype: "" };
				if (failListVolumesAfterCreate) {
					failListVolumesAfterCreate = false;
					failListVolumes = true;
				}
				if (failCreateVolume) {
					failCreateVolume = false;
					return yield* Effect.fail(flyUnavailable("create_volume"));
				}
				return echoed;
			}),
		listMachines: (_name: string) =>
			Effect.gen(function* () {
				if (failListMachines) {
					failListMachines = false;
					return yield* Effect.fail(flyUnavailable("list_machines"));
				}
				return machines;
			}),
		getMachine: (_name: string, id: string) =>
			Effect.gen(function* () {
				if (failGetMachine) {
					failGetMachine = false;
					return yield* Effect.fail(flyUnavailable("get_machine"));
				}
				return Option.fromNullishOr(machines.find((machine) => machine.id === id));
			}),
		createMachine: (input: {
			readonly appName: string;
			readonly name: string;
			readonly region: string;
			readonly config: FlyMachine["config"];
		}) =>
			Effect.gen(function* () {
				calls.createMachine += 1;
				if (failCreateMachineBeforeMutation) {
					failCreateMachineBeforeMutation = false;
					return yield* Effect.fail(flyUnavailable("create_machine"));
				}
				// Fly describes the attached Volume back on the mount rather than echoing the request.
				const attached = volumes.find((volume) => volume.id === input.config.mounts[0]?.volume);
				const machine: FlyMachine = {
					id: "machine-id",
					name: input.name,
					state: "stopped",
					region: input.region,
					instance_id: "machine-version-1",
					config: {
						...input.config,
						mounts: input.config.mounts.map((mount) =>
							attached === undefined
								? mount
								: { ...mount, encrypted: attached.encrypted, name: attached.name, size_gb: attached.size_gb },
						),
					},
					checks: [{ status: "passing" }],
				};
				const volumeIndex = volumes.findIndex((volume) => volume.id === input.config.mounts[0]?.volume);
				if (volumeIndex >= 0) volumes[volumeIndex] = { ...volumes[volumeIndex]!, attached_machine_id: machine.id };
				machines.push(machine);
				if (failCreateMachine) {
					failCreateMachine = false;
					return yield* Effect.fail(flyUnavailable("create_machine"));
				}
				return machine;
			}),
		startMachine: (_name: string, id: string) =>
			Effect.gen(function* () {
				calls.startMachine += 1;
				if (failStartMachineBeforeMutation) {
					failStartMachineBeforeMutation = false;
					return yield* Effect.fail(flyUnavailable("start_machine"));
				}
				// Fly answers 412 `failed_precondition: unable to start machine from current state:
				// 'created'` until a Machine created with skip_launch settles.
				if (startPreconditionFailures > 0) {
					startPreconditionFailures -= 1;
					return yield* Effect.fail(new FlyApiError({ operation: "start_machine", reason: "status", status: 412 }));
				}
				const index = machines.findIndex((machine) => machine.id === id);
				if (index >= 0) machines[index] = { ...machines[index]!, state: "started", checks: [{ status: "passing" }] };
			}),
		waitMachine: (_name: string, _id: string, state: "started", version: string) =>
			Effect.succeed({ ok: true, state, version }),
		listVolumeSnapshots: () => Effect.succeed([]),
	};
	const edge = {
		health: (_hostname: string) =>
			Effect.gen(function* () {
				if (failHealth) {
					failHealth = false;
					return yield* Effect.fail(new EdgeProbeError({ path: "/health", reason: "network" }));
				}
			}).pipe(Effect.asVoid),
		childRoute: (_hostname: string) =>
			Effect.gen(function* () {
				if (failChildRoute) {
					failChildRoute = false;
					return yield* Effect.fail(new EdgeProbeError({ path: "/init", reason: "network" }));
				}
			}).pipe(Effect.asVoid),
	};
	return {
		fake,
		edge,
		networking,
		calls,
		set: {
			decodeAppRead: () => {
				decodeAppRead = true;
			},
			rejectAppRead: () => {
				rejectAppRead = true;
			},
			hideVolumes: () => {
				hideVolumes = true;
			},
			app: (value: FlyApp | undefined) => {
				app = value;
			},
			hideAppAfterCreate: () => {
				hideAppReads = 1;
			},
			failListVolumes: () => {
				failListVolumes = true;
			},
			failGetVolume: () => {
				failGetVolume = true;
			},
			failListMachines: () => {
				failListMachines = true;
			},
			failGetMachine: () => {
				failGetMachine = true;
			},
			failCreateApp: () => {
				failCreateApp = true;
			},
			failCreateAppBeforeMutation: () => {
				failCreateAppBeforeMutation = true;
			},
			rejectCreateApp: () => {
				rejectCreateApp = true;
			},
			rejectCreateAppAndReadback: () => {
				rejectCreateApp = true;
				failAppReadAfterRejectedCreate = true;
			},
			delayCreateApp: (milliseconds: number) => {
				createAppDelayMs = milliseconds;
			},
			failCreateVolume: () => {
				failCreateVolume = true;
			},
			failCreateVolumeAndReadback: () => {
				failCreateVolume = true;
				failListVolumesAfterCreate = true;
			},
			failCreateVolumeBeforeMutation: () => {
				failCreateVolumeBeforeMutation = true;
			},
			failCreateMachine: () => {
				failCreateMachine = true;
			},
			failCreateMachineBeforeMutation: () => {
				failCreateMachineBeforeMutation = true;
			},
			failStartMachineBeforeMutation: () => {
				failStartMachineBeforeMutation = true;
			},
			failStartMachinePrecondition: (times: number) => {
				startPreconditionFailures = times;
			},
			failHealth: () => {
				failHealth = true;
			},
			failChildRoute: () => {
				failChildRoute = true;
			},
			addDuplicateVolume: () => {
				volumes.push(volumeFor());
				volumes.push({ ...volumeFor(), id: "duplicate-volume-id" });
			},
			volume: (value: FlyVolume) => {
				volumes.push(value);
			},
			machine: (value: FlyMachine) => {
				const volumeIndex = volumes.findIndex((volume) => volume.id === value.config.mounts[0]?.volume);
				if (volumeIndex >= 0) volumes[volumeIndex] = { ...volumes[volumeIndex]!, attached_machine_id: value.id };
				machines.push(value);
			},
			stopMachines: () => {
				for (const [index, machine] of machines.entries())
					machines[index] = { ...machine, state: "stopped", checks: [] };
			},
		},
		resources: () => ({ apps: app ? 1 : 0, volumes: volumes.length, machines: machines.length }),
	};
};

// Resolves every channel to `imageRef`, recording each request so tests can assert a board resolves
// its channel once rather than on every provisioning pass.
export const makeFakeRegistry = () => {
	const resolved: Array<ReleaseChannel> = [];
	let unavailable = false;
	return {
		resolved,
		failNext: () => {
			unavailable = true;
		},
		registry: {
			resolve: (channel: ReleaseChannel) =>
				Effect.suspend(() => {
					resolved.push(channel);
					if (unavailable) {
						unavailable = false;
						return Effect.fail(new ImageRegistryError({ channel, reason: "network" }));
					}
					return Effect.succeed(imageRef);
				}),
		},
	};
};

const providerLayer = (provider: ReturnType<typeof makeFakeProvider>, registry: ReturnType<typeof makeFakeRegistry>) =>
	Layer.mergeAll(
		Layer.succeed(FlyBoardApi, provider.fake),
		Layer.succeed(CloudflareDns, provider.networking.dns),
		Layer.succeed(EdgeProbe, provider.edge),
		Layer.succeed(ImageRegistry, registry.registry),
	);

export const provisionerFor = (
	provider: ReturnType<typeof makeFakeProvider>,
	config = settings,
	registry = makeFakeRegistry(),
) => provisionerLayer(config).pipe(Layer.provide(providerLayer(provider, registry)));

export const nextClaim = (workerId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE board_operations SET available_at = clock_timestamp()`;
		return Option.getOrThrow(yield* (yield* Operations).claim(workerId, 30_000));
	});
