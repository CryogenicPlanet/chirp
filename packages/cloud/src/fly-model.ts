import { Schema } from "effect";

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
	attached_machine_id: Schema.optionalKey(Schema.String),
	snapshot_retention: Schema.optionalKey(Schema.Int),
});
export type FlyVolume = typeof FlyVolume.Type;

const FlyMachineMount = Schema.Struct({ volume: Schema.String, path: Schema.String });

const FlyMachineCheck = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
});

const FlyMachinePort = Schema.Struct({
	port: Schema.Int,
	handlers: Schema.Array(Schema.String),
	force_https: Schema.optionalKey(Schema.Boolean),
});

const FlyMachineServiceCheck = Schema.Struct({
	type: Schema.String,
	port: Schema.Int,
	method: Schema.String,
	path: Schema.String,
	interval: Schema.String,
	timeout: Schema.String,
	grace_period: Schema.String,
});

const FlyMachineService = Schema.Struct({
	protocol: Schema.String,
	internal_port: Schema.Int,
	autostart: Schema.Boolean,
	autostop: Schema.String,
	min_machines_running: Schema.Int,
	ports: Schema.Array(FlyMachinePort),
	checks: Schema.Array(FlyMachineServiceCheck),
});

const FlyMachineGuest = Schema.Struct({
	cpu_kind: Schema.String,
	cpus: Schema.Int,
	memory_mb: Schema.Int,
});

export const FlyMachineConfig = Schema.Struct({
	image: Schema.String,
	env: StringMap,
	metadata: StringMap,
	mounts: Schema.Array(FlyMachineMount),
	guest: FlyMachineGuest,
	services: Schema.Array(FlyMachineService),
	stop_config: Schema.Struct({ signal: Schema.String, timeout: Schema.String }),
});
export type FlyMachineConfig = typeof FlyMachineConfig.Type;

export const FlyMachine = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	state: Schema.String,
	region: Schema.String,
	instance_id: Schema.String,
	config: FlyMachineConfig,
	checks: Schema.optionalKey(Schema.Array(FlyMachineCheck)),
});
export type FlyMachine = typeof FlyMachine.Type;

export const FlyVolumeSnapshot = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	status: Schema.optionalKey(Schema.String),
	created_at: Schema.optionalKey(Schema.String),
	digest: Schema.optionalKey(Schema.String),
	retention_days: Schema.optionalKey(Schema.Int),
});
export type FlyVolumeSnapshot = typeof FlyVolumeSnapshot.Type;

export const FlyWaitResult = Schema.Struct({
	ok: Schema.optionalKey(Schema.Boolean),
	state: Schema.optionalKey(Schema.String),
	version: Schema.optionalKey(Schema.String),
});
