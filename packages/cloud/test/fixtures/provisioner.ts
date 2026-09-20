import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CloudflareDns } from "../../src/cloudflare-dns.ts";
import type { DeploymentState } from "../../src/deployment.ts";
import { EdgeProbe, EdgeProbeError } from "../../src/edge-probe.ts";
import { FlyApiError, FlyBoardApi } from "../../src/fly-board-api.ts";
import type { FlyApp, FlyMachine, FlyVolume } from "../../src/fly-model.ts";
import { Operations } from "../../src/operations.ts";
import { provisionerLayer } from "../../src/provisioner.ts";
import type { ProvisioningSettings } from "../../src/provisioning-settings.ts";
import { makeNetworking } from "./edge-networking.ts";

export const settings: ProvisioningSettings = {
	organization: "chirp",
	region: "sjc",
	imageRef: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	boardsDomain: "boards.chirp.wiki",
	volumeSizeGb: 1,
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

export const volumeFor = (slug: string): FlyVolume => ({
	id: "volume-id",
	name: `chirp_data_${slug}`,
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
	let hideVolumes = false;
	let failListVolumes = false;
	let failGetVolume = false;
	let failListMachines = false;
	let failGetMachine = false;
	let failCreateApp = false;
	let rejectCreateApp = false;
	let failCreateVolume = false;
	let failCreateMachine = false;
	let failHealth = false;
	let failChildRoute = false;
	const calls = {
		createApp: 0,
		createVolume: 0,
		createMachine: 0,
	};
	const fake = {
		...networking.fly,
		getApp: (name: string) =>
			Effect.gen(function* () {
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
				if (rejectCreateApp) {
					rejectCreateApp = false;
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
				const volume = { ...volumeFor(input.name.replace(/^chirp_data_/, "")), name: input.name };
				volumes.push(volume);
				if (failCreateVolume) {
					failCreateVolume = false;
					return yield* Effect.fail(flyUnavailable("create_volume"));
				}
				return volume;
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
				const machine: FlyMachine = {
					id: "machine-id",
					name: input.name,
					state: "stopped",
					region: input.region,
					instance_id: "machine-version-1",
					config: input.config,
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
			Effect.sync(() => {
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
			rejectCreateApp: () => {
				rejectCreateApp = true;
			},
			failCreateVolume: () => {
				failCreateVolume = true;
			},
			failCreateMachine: () => {
				failCreateMachine = true;
			},
			failHealth: () => {
				failHealth = true;
			},
			failChildRoute: () => {
				failChildRoute = true;
			},
			addDuplicateVolume: (slug: string) => {
				volumes.push(volumeFor(slug));
				volumes.push({ ...volumeFor(slug), id: "duplicate-volume-id" });
			},
			volume: (value: FlyVolume) => {
				volumes.push(value);
			},
			machine: (value: FlyMachine) => {
				const volumeIndex = volumes.findIndex((volume) => volume.id === value.config.mounts[0]?.volume);
				if (volumeIndex >= 0) volumes[volumeIndex] = { ...volumes[volumeIndex]!, attached_machine_id: value.id };
				machines.push(value);
			},
		},
		resources: () => ({ apps: app ? 1 : 0, volumes: volumes.length, machines: machines.length }),
	};
};

const providerLayer = (provider: ReturnType<typeof makeFakeProvider>) =>
	Layer.mergeAll(
		Layer.succeed(FlyBoardApi, provider.fake),
		Layer.succeed(CloudflareDns, provider.networking.dns),
		Layer.succeed(EdgeProbe, provider.edge),
	);

export const provisionerFor = (provider: ReturnType<typeof makeFakeProvider>, config = settings) =>
	provisionerLayer(config).pipe(Layer.provide(providerLayer(provider)));

export const nextClaim = (workerId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE board_operations SET available_at = clock_timestamp()`;
		return Option.getOrThrow(yield* (yield* Operations).claim(workerId, 30_000));
	});
