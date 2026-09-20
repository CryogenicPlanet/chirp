import { Effect, Schema } from "effect";

const StringMap = Schema.Record(Schema.String, Schema.String);

export const FlyAppDetails = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	organization: Schema.Struct({ slug: Schema.String }),
});
const FlyAppListing = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	network: Schema.String,
});
export const FlyApps = Schema.Struct({
	total_apps: Schema.Int,
	apps: Schema.Array(FlyAppListing),
});
export const FlyApp = Schema.Struct({ ...FlyAppDetails.fields, network: Schema.String });
export type FlyApp = typeof FlyApp.Type;

export const FlyAppCreated = Schema.Struct({ id: Schema.String, created_at: Schema.Number });

export const FlyIpAssignment = Schema.Struct({
	ip: Schema.String,
	shared: Schema.Boolean,
	egress: Schema.optionalKey(Schema.Boolean),
});
export type FlyIpAssignment = typeof FlyIpAssignment.Type;
export const FlyIpAssignments = Schema.Struct({ ips: Schema.Array(FlyIpAssignment) });
export const FlyCertificate = Schema.Struct({
	hostname: Schema.String,
	configured: Schema.Boolean,
	acme_requested: Schema.Boolean,
	status: Schema.String,
	certificates: Schema.Array(Schema.Struct({ source: Schema.String, status: Schema.String })),
	validation: Schema.Struct({ ownership_txt_configured: Schema.Boolean }),
	dns_requirements: Schema.Struct({
		a: Schema.Array(Schema.String),
		ownership: Schema.Struct({ name: Schema.String, app_value: Schema.String }),
	}),
});
export type FlyCertificate = typeof FlyCertificate.Type;
export const FlyCertificateCheck = Schema.Struct({
	...FlyCertificate.fields,
	dns_records: Schema.Struct({
		a: Schema.NullOr(Schema.Array(Schema.String)),
		aaaa: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
	}),
});

export const FlyVolume = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	state: Schema.String,
	region: Schema.String,
	encrypted: Schema.Boolean,
	size_gb: Schema.Int,
	auto_backup_enabled: Schema.Boolean,
	fstype: Schema.String,
	attached_machine_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	snapshot_retention: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
export type FlyVolume = typeof FlyVolume.Type;

const FlyMachineMount = Schema.StructWithRest(Schema.Struct({ volume: Schema.String, path: Schema.String }), [
	Schema.Record(Schema.String, Schema.Json),
]);

const FlyMachineCheck = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const FlyMachinePort = Schema.StructWithRest(
	Schema.Struct({
		port: Schema.Int,
		handlers: Schema.Array(Schema.String),
		force_https: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	}),
	[Schema.Record(Schema.String, Schema.Json)],
);

const FlyMachineServiceCheck = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		port: Schema.Int,
		method: Schema.String,
		path: Schema.String,
		interval: Schema.String,
		timeout: Schema.String,
		grace_period: Schema.String,
	}),
	[Schema.Record(Schema.String, Schema.Json)],
);

const FlyMachineService = Schema.StructWithRest(
	Schema.Struct({
		protocol: Schema.String,
		internal_port: Schema.Int,
		autostart: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
		autostop: Schema.Union([Schema.String, Schema.Boolean]).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
		min_machines_running: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
		force_instance_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
		ports: Schema.Array(FlyMachinePort),
		checks: Schema.Array(FlyMachineServiceCheck).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	}),
	[Schema.Record(Schema.String, Schema.Json)],
);

const FlyMachineGuest = Schema.StructWithRest(
	Schema.Struct({
		cpu_kind: Schema.String,
		cpus: Schema.Int,
		memory_mb: Schema.Int,
	}),
	[Schema.Record(Schema.String, Schema.Json)],
);

const FlyMachineRestart = Schema.StructWithRest(
	Schema.Struct({ policy: Schema.String, max_retries: Schema.optionalKey(Schema.Int) }),
	[Schema.Record(Schema.String, Schema.Json)],
);

const UnknownMap = Schema.Record(Schema.String, Schema.Json);

export const FlyMachineConfig = Schema.StructWithRest(
	Schema.Struct({
		image: Schema.String,
		env: StringMap,
		metadata: StringMap,
		mounts: Schema.Array(FlyMachineMount),
		guest: FlyMachineGuest,
		services: Schema.Array(FlyMachineService),
		stop_config: Schema.StructWithRest(Schema.Struct({ signal: Schema.String, timeout: Schema.String }), [UnknownMap]),
		auto_destroy: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
		init: Schema.optionalKey(Schema.NullOr(UnknownMap)),
		restart: Schema.optionalKey(Schema.NullOr(FlyMachineRestart)),
		dns: Schema.optionalKey(Schema.NullOr(UnknownMap)),
	}),
	[UnknownMap],
);
export type FlyMachineConfig = typeof FlyMachineConfig.Type;

export const FlyMachine = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	state: Schema.String,
	region: Schema.String,
	instance_id: Schema.String,
	config: FlyMachineConfig,
	checks: Schema.optionalKey(Schema.NullOr(Schema.Array(FlyMachineCheck))),
});
export type FlyMachine = typeof FlyMachine.Type;

export const FlyVolumeSnapshot = Schema.Struct({
	id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
	digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
	retention_days: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});
export type FlyVolumeSnapshot = typeof FlyVolumeSnapshot.Type;

export const FlyWaitResult = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	state: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
});
