import { describe, expect, test } from "vitest";
import type { Deployment } from "../src/deployment.ts";
import type { FlyMachine } from "../src/fly-model.ts";
import { machineConfig, machineMatches } from "../src/machine-spec.ts";

const deployment: Deployment = {
	board_id: "00000000-0000-4000-8000-000000000001",
	state: "machine_created",
	row_version: 5,
	hostname: "0123456789abcdef0123456789abcdef.boards.chirp.wiki",
	storage_engine: "sqlite",
	region: "sjc",
	image_ref: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	app_name: "chirp-0123456789abcdef0123456789abcdef",
	network_name: "chirp-0123456789abcdef0123456789abcdef",
	volume_name: "chirp_data_0123456789abcdef0123456789abcdef",
	machine_name: "board-0123456789abcdef0123456789abcdef",
	volume_size_gb: 1,
	app_id: "app-id",
	volume_id: "volume-id",
	machine_id: "machine-id",
	last_snapshot_id: null,
	last_snapshot_created_at: null,
	last_snapshot_digest: null,
	last_snapshot_retention_days: null,
	created_at: new Date("2026-09-20T00:00:00.000Z"),
	updated_at: new Date("2026-09-20T00:00:00.000Z"),
};

const observedMachine = (): FlyMachine => {
	const config = machineConfig(deployment);
	return {
		id: "machine-id",
		name: deployment.machine_name,
		state: "started",
		region: deployment.region,
		instance_id: "version-1",
		config: {
			...config,
			init: {},
			dns: {},
			services: config.services.map((service) => ({
				...service,
				autostop: true,
				min_machines_running: null,
				force_instance_key: null,
				ports: [...service.ports].reverse().map((port) => ({ ...port, handlers: [...port.handlers].reverse() })),
			})),
		},
		checks: [{ status: "passing" }],
	};
};

describe("managed Fly Machine intent", () => {
	test("accepts provider-normalized autostop and unordered ports and handlers", () => {
		expect(machineMatches(observedMachine(), deployment)).toBe(true);
	});

	test("rejects extra environment, metadata, and configuration", () => {
		const machine = observedMachine();
		expect(
			machineMatches(
				{ ...machine, config: { ...machine.config, env: { ...machine.config.env, REOPEN_SETUP: "1" } } },
				deployment,
			),
		).toBe(false);
		expect(
			machineMatches(
				{ ...machine, config: { ...machine.config, metadata: { ...machine.config.metadata, foreign: "value" } } },
				deployment,
			),
		).toBe(false);
		expect(machineMatches({ ...machine, config: { ...machine.config, processes: ["app"] } }, deployment)).toBe(false);
		expect(
			machineMatches(
				{
					...machine,
					config: {
						...machine.config,
						services: machine.config.services.map((service) => ({ ...service, force_instance_key: "foreign" })),
					},
				},
				deployment,
			),
		).toBe(false);
	});

	test("rejects duplicate ports and handlers that omit required intent", () => {
		const machine = observedMachine();
		const service = machine.config.services[0]!;
		expect(
			machineMatches(
				{
					...machine,
					config: {
						...machine.config,
						services: [{ ...service, ports: [service.ports[0]!, service.ports[0]!] }],
					},
				},
				deployment,
			),
		).toBe(false);
		expect(
			machineMatches(
				{
					...machine,
					config: {
						...machine.config,
						services: [
							{
								...service,
								ports: service.ports.map((port) => ({
									...port,
									handlers: port.port === 443 ? ["tls", "tls"] : port.handlers,
								})),
							},
						],
					},
				},
				deployment,
			),
		).toBe(false);
	});
});
