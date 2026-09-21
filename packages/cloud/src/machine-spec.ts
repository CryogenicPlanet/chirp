import type { Deployment } from "./deployment.ts";
import type { FlyMachine, FlyMachineConfig } from "./fly-model.ts";

export const machineConfig = (deployment: Deployment): FlyMachineConfig => ({
	image: deployment.image_ref,
	env: {
		RP_ID: deployment.hostname,
		PUBLIC_ORIGIN: `https://${deployment.hostname}`,
	},
	metadata: {
		"chirp.deployment_id": deployment.board_id,
		"chirp.controller_schema": "1",
	},
	auto_destroy: false,
	restart: { policy: "on-failure", max_retries: 10 },
	mounts: [{ volume: deployment.volume_id ?? "", path: "/data" }],
	guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
	services: [
		{
			protocol: "tcp",
			internal_port: 8080,
			autostart: true,
			autostop: "stop",
			min_machines_running: 0,
			ports: [
				{ port: 80, handlers: ["http"], force_https: true },
				{ port: 443, handlers: ["tls", "http"] },
			],
			checks: [
				{
					type: "http",
					port: 8080,
					method: "GET",
					path: "/health",
					interval: "15s",
					timeout: "2s",
					grace_period: "10s",
				},
			],
		},
	],
	stop_config: { signal: "SIGTERM", timeout: "30s" },
});

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
	Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const onlyKeys = (value: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
	Object.keys(value).every((key) => keys.includes(key));

const sameRecord = (actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>) =>
	exactKeys(actual, Object.keys(expected)) && Object.entries(expected).every(([key, value]) => actual[key] === value);

export const machineMatches = (machine: FlyMachine, deployment: Deployment) => {
	const config = machine.config;
	const expected = machineConfig(deployment);
	const mount = config.mounts[0];
	const service = config.services[0];
	const expectedService = expected.services[0];
	const portsMatch =
		service !== undefined &&
		expectedService !== undefined &&
		service.ports.length === expectedService.ports.length &&
		new Set(service.ports.map((port) => port.port)).size === service.ports.length &&
		service.ports.every((port) => {
			const expectedPort = expectedService.ports.find((candidate) => candidate.port === port.port);
			return (
				expectedPort !== undefined &&
				onlyKeys(port, ["port", "handlers", "force_https"]) &&
				(port.force_https ?? false) === (expectedPort.force_https ?? false) &&
				port.handlers.length === expectedPort.handlers.length &&
				new Set(port.handlers).size === port.handlers.length &&
				port.handlers.every((handler) => expectedPort.handlers.includes(handler))
			);
		});
	const checksMatch =
		service !== undefined &&
		expectedService !== undefined &&
		service.checks.length === expectedService.checks.length &&
		service.checks.every((check) => {
			const expectedCheck = expectedService.checks.find(
				(candidate) =>
					candidate.type === check.type &&
					candidate.port === check.port &&
					candidate.method === check.method &&
					candidate.path === check.path,
			);
			return (
				expectedCheck !== undefined &&
				exactKeys(check, ["type", "port", "method", "path", "interval", "timeout", "grace_period"]) &&
				check.interval === expectedCheck.interval &&
				check.timeout === expectedCheck.timeout &&
				check.grace_period === expectedCheck.grace_period
			);
		});
	const normalizedAutostop = service?.autostop === true || service?.autostop === "stop" ? "stop" : service?.autostop;
	const platformVersion = config.metadata.fly_platform_version;
	const mountName = mount?.name;
	const mountSize = mount?.size_gb;
	const mountEncrypted = mount?.encrypted;
	return (
		machine.name === deployment.machine_name &&
		machine.region === deployment.region &&
		Object.keys(config).every((key) =>
			[
				"image",
				"env",
				"metadata",
				"mounts",
				"guest",
				"services",
				"stop_config",
				"auto_destroy",
				"init",
				"restart",
				"dns",
			].includes(key),
		) &&
		config.image === expected.image &&
		sameRecord(config.env, expected.env) &&
		Object.entries(expected.metadata).every(([key, value]) => config.metadata[key] === value) &&
		onlyKeys(config.metadata, [...Object.keys(expected.metadata), "fly_platform_version"]) &&
		(platformVersion === undefined || typeof platformVersion === "string") &&
		(config.auto_destroy ?? false) === false &&
		(config.init == null || Object.keys(config.init).length === 0) &&
		config.restart != null &&
		config.restart?.policy === expected.restart?.policy &&
		config.restart?.max_retries === expected.restart?.max_retries &&
		exactKeys(config.restart, ["policy", "max_retries"]) &&
		(config.dns == null || Object.keys(config.dns).length === 0) &&
		config.mounts.length === 1 &&
		mount?.volume === deployment.volume_id &&
		mount.path === "/data" &&
		onlyKeys(mount, ["volume", "path", "name", "size_gb", "encrypted"]) &&
		(mountName === undefined || mountName === deployment.volume_name) &&
		(mountSize === undefined || (typeof mountSize === "number" && mountSize >= deployment.volume_size_gb)) &&
		(mountEncrypted === undefined || mountEncrypted === true) &&
		config.services.length === 1 &&
		service !== undefined &&
		exactKeys(service, [
			"protocol",
			"internal_port",
			"autostart",
			"autostop",
			"min_machines_running",
			...(service.force_instance_key === undefined ? [] : ["force_instance_key"]),
			"ports",
			"checks",
		]) &&
		service.protocol === expectedService?.protocol &&
		service.internal_port === 8080 &&
		service.autostart === true &&
		normalizedAutostop === "stop" &&
		(service.min_machines_running ?? 0) === 0 &&
		service.force_instance_key == null &&
		portsMatch &&
		checksMatch &&
		exactKeys(config.guest, ["cpu_kind", "cpus", "memory_mb"]) &&
		config.guest.cpu_kind === expected.guest.cpu_kind &&
		config.guest.cpus === expected.guest.cpus &&
		config.guest.memory_mb === expected.guest.memory_mb &&
		exactKeys(config.stop_config, ["signal", "timeout"]) &&
		config.stop_config.signal === expected.stop_config.signal &&
		config.stop_config.timeout === expected.stop_config.timeout
	);
};
