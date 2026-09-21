import { Effect, Option } from "effect";
import { CloudflareApiError, type DnsRecord } from "../../src/cloudflare-dns.ts";
import { FlyApiError } from "../../src/fly-board-api.ts";
import type { FlyCertificate, FlyIpAssignment } from "../../src/fly-model.ts";

export const makeNetworking = () => {
	const state: {
		ips: FlyIpAssignment[];
		certificate: FlyCertificate | undefined;
		records: DnsRecord[];
		ready: boolean;
		resolved: string[];
		aaaa: string[] | null | undefined;
		zone: { name: string; status: string; type: string };
		failBefore: Set<string>;
		failAfter: Set<string>;
		calls: string[];
		checkCertificateCalls: number;
		checkCertificateDelayAt: number;
		checkCertificateDelayMs: number;
	} = {
		ips: [],
		certificate: undefined,
		records: [],
		ready: true,
		resolved: ["66.241.124.100"],
		aaaa: null,
		zone: { name: "chirp.wiki", status: "active", type: "full" },
		failBefore: new Set(),
		failAfter: new Set(),
		calls: [],
		checkCertificateCalls: 0,
		checkCertificateDelayAt: Number.POSITIVE_INFINITY,
		checkCertificateDelayMs: 0,
	};
	const call = <A>(operation: string, provider: "fly" | "cloudflare", body: () => A) =>
		Effect.gen(function* () {
			state.calls.push(operation);
			const error = () =>
				provider === "fly"
					? new FlyApiError({ operation, reason: "transport", status: null })
					: new CloudflareApiError({ operation, reason: "transport", status: null });
			if (state.failBefore.delete(operation)) return yield* error();
			const result = body();
			if (state.failAfter.delete(operation)) return yield* error();
			return result;
		});
	const flyCall = <A>(operation: string, body: () => A) =>
		call(operation, "fly", body).pipe(
			Effect.mapError(() => new FlyApiError({ operation, reason: "transport", status: null })),
		);
	const dnsCall = <A>(operation: string, body: () => A) =>
		call(operation, "cloudflare", body).pipe(
			Effect.mapError(() => new CloudflareApiError({ operation, reason: "transport", status: null })),
		);
	return {
		state,
		fly: {
			getApp: () => Effect.die("Unexpected getApp"),
			createApp: () => Effect.die("Unexpected createApp"),
			listVolumes: () => Effect.die("Unexpected listVolumes"),
			getVolume: () => Effect.die("Unexpected getVolume"),
			createVolume: () => Effect.die("Unexpected createVolume"),
			listMachines: () => Effect.die("Unexpected listMachines"),
			getMachine: () => Effect.die("Unexpected getMachine"),
			createMachine: () => Effect.die("Unexpected createMachine"),
			startMachine: () => Effect.die("Unexpected startMachine"),
			waitMachine: () => Effect.die("Unexpected waitMachine"),
			listVolumeSnapshots: () => Effect.die("Unexpected listVolumeSnapshots"),
			listIpAssignments: () => flyCall("list_ips", () => state.ips),
			allocateSharedIp: () =>
				flyCall("allocate_ip", () => {
					const ip = { ip: "66.241.124.100", shared: true };
					state.ips.push(ip);
					return ip;
				}),
			getCertificate: () => flyCall("get_certificate", () => Option.fromNullishOr(state.certificate)),
			createCertificate: (_app: string, hostname: string) =>
				flyCall("create_certificate", () => {
					state.certificate = {
						hostname,
						acme_requested: true,
						configured: false,
						status: "pending_validation",
						certificates: [],
						validation: { ownership_txt_configured: false },
						dns_requirements: {
							a: ["66.241.124.100"],
							ownership: { name: `_fly-ownership.${hostname}`, app_value: "app-123" },
						},
					};
					return state.certificate;
				}),
			checkCertificate: () =>
				Effect.gen(function* () {
					state.checkCertificateCalls += 1;
					if (state.checkCertificateCalls === state.checkCertificateDelayAt)
						yield* Effect.sleep(state.checkCertificateDelayMs);
					return yield* flyCall("check_certificate", () => {
						if (!state.certificate) throw new Error("Certificate not created");
						return {
							...state.certificate,
							configured: state.ready,
							status: state.ready ? "active" : "pending_validation",
							certificates: state.ready ? [{ source: "fly", status: "active" }] : [],
							validation: { ownership_txt_configured: state.ready },
							dns_records: { a: state.resolved, ...(state.aaaa === undefined ? {} : { aaaa: state.aaaa }) },
						};
					});
				}),
		},
		dns: {
			getZone: dnsCall("get_zone", () => state.zone),
			listRecords: (name: string) =>
				dnsCall(`list:${name}`, () => state.records.filter((record) => record.name === name)),
			createRecord: (name: string, type: "A" | "TXT", content: string) =>
				dnsCall(`create:${type}`, () => {
					state.records.push({ id: String(state.records.length), name, type, content, proxied: false });
				}),
		},
	};
};
