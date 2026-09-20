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
		"chirp.desired_revision": String(deployment.desired_revision),
		"chirp.controller_schema": "1",
	},
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
		service.ports.every(
			(port, index) =>
				port.port === expectedService.ports[index]?.port &&
				port.force_https === expectedService.ports[index]?.force_https &&
				port.handlers.length === expectedService.ports[index]?.handlers.length &&
				port.handlers.every(
					(handler, handlerIndex) => handler === expectedService.ports[index]?.handlers[handlerIndex],
				),
		);
	const checksMatch =
		service !== undefined &&
		expectedService !== undefined &&
		service.checks.length === expectedService.checks.length &&
		service.checks.every((check, index) => {
			const expectedCheck = expectedService.checks[index];
			return (
				check.type === expectedCheck?.type &&
				check.port === expectedCheck.port &&
				check.method === expectedCheck.method &&
				check.path === expectedCheck.path &&
				check.interval === expectedCheck.interval &&
				check.timeout === expectedCheck.timeout &&
				check.grace_period === expectedCheck.grace_period
			);
		});
	return (
		machine.name === deployment.machine_name &&
		machine.region === deployment.region &&
		config.image === expected.image &&
		config.env.RP_ID === expected.env.RP_ID &&
		config.env.PUBLIC_ORIGIN === expected.env.PUBLIC_ORIGIN &&
		config.metadata["chirp.deployment_id"] === deployment.board_id &&
		config.metadata["chirp.desired_revision"] === String(deployment.desired_revision) &&
		config.metadata["chirp.controller_schema"] === "1" &&
		config.mounts.length === 1 &&
		mount?.volume === deployment.volume_id &&
		mount.path === "/data" &&
		config.services.length === 1 &&
		service !== undefined &&
		service.protocol === expectedService?.protocol &&
		service.internal_port === 8080 &&
		service.autostart === true &&
		service.autostop === "stop" &&
		service.min_machines_running === 0 &&
		portsMatch &&
		checksMatch &&
		config.guest.cpu_kind === expected.guest.cpu_kind &&
		config.guest.cpus === expected.guest.cpus &&
		config.guest.memory_mb === expected.guest.memory_mb &&
		config.stop_config.signal === expected.stop_config.signal &&
		config.stop_config.timeout === expected.stop_config.timeout
	);
};
