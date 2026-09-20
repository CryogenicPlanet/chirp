import { isIPv4 } from "node:net";
import { Data, Effect, Option, Result } from "effect";
import { type CloudflareApiError, CloudflareDns } from "./cloudflare-dns.ts";
import { type FlyApiError, FlyBoardApi } from "./fly-board-api.ts";
import type { FlyCertificate, FlyIpAssignment } from "./fly-model.ts";

export class EdgeNetworkingError extends Data.TaggedError("EdgeNetworkingError")<{
	readonly reason: "pending" | "conflict" | "rejected" | "unavailable";
}> {}

const problem = (reason: EdgeNetworkingError["reason"]) => new EdgeNetworkingError({ reason });
const failedMutation = (error: FlyApiError | CloudflareApiError) =>
	problem(
		error.reason === "status" &&
			error.status !== null &&
			error.status >= 400 &&
			error.status < 500 &&
			![408, 409, 425, 429].includes(error.status)
			? "rejected"
			: "pending",
	);

export const ensureEdgeNetworking = <E, R>(
	appName: string,
	hostname: string,
	renewLease: Effect.Effect<unknown, E, R>,
) =>
	Effect.gen(function* () {
		const fly = yield* FlyBoardApi;
		const dns = yield* CloudflareDns;
		const observe = <A>(effect: Effect.Effect<A, FlyApiError | CloudflareApiError>) =>
			renewLease.pipe(
				Effect.andThen(
					effect.pipe(
						Effect.mapError((error) =>
							error.reason === "status" && [401, 403].includes(error.status ?? 0)
								? problem("rejected")
								: problem("unavailable"),
						),
					),
				),
			);
		const shared = (ips: ReadonlyArray<FlyIpAssignment>) => ips.filter((ip) => ip.shared);
		let ips = shared(yield* observe(fly.listIpAssignments(appName)));
		if (ips.length === 0) {
			yield* renewLease;
			const created = yield* fly.allocateSharedIp(appName).pipe(Effect.result);
			ips = shared(yield* observe(fly.listIpAssignments(appName)));
			if (ips.length === 0)
				return yield* Result.isFailure(created) ? failedMutation(created.failure) : problem("pending");
		}
		if (ips.length !== 1 || ips[0]!.egress || !isIPv4(ips[0]!.ip)) return yield* problem("conflict");
		const address = ips[0]!.ip;
		let found = yield* observe(fly.getCertificate(appName, hostname));
		if (Option.isNone(found)) {
			yield* renewLease;
			const created = yield* fly.createCertificate(appName, hostname).pipe(Effect.result);
			found = yield* observe(fly.getCertificate(appName, hostname));
			if (Option.isNone(found))
				return yield* Result.isFailure(created) ? failedMutation(created.failure) : problem("pending");
		}
		const assertCertificate = (certificate: FlyCertificate) =>
			certificate.hostname === hostname &&
			certificate.acme_requested &&
			certificate.dns_requirements.a.includes(address) &&
			certificate.dns_requirements.ownership.name === `_fly-ownership.${hostname}` &&
			/^app-[a-zA-Z0-9]+$/.test(certificate.dns_requirements.ownership.app_value) &&
			!certificate.certificates.some((entry) => entry.source === "custom")
				? Effect.succeed(certificate)
				: Effect.fail(problem("conflict"));
		const certificate = yield* assertCertificate(found.value);
		const zone = yield* observe(dns.getZone);
		if (zone.status !== "active" || zone.type !== "full" || !hostname.endsWith(`.${zone.name}`))
			return yield* problem("conflict");
		let parent = hostname.slice(hostname.indexOf(".") + 1);
		while (parent !== zone.name) {
			const records = yield* observe(dns.listRecords(parent));
			if (records.some((record) => record.type === "NS" || record.type === "CNAME")) return yield* problem("conflict");
			parent = parent.slice(parent.indexOf(".") + 1);
		}
		const ensureRecord = (name: string, type: "A" | "TXT", content: string) =>
			Effect.gen(function* () {
				let records = yield* observe(dns.listRecords(name));
				if (records.length === 0) {
					yield* renewLease;
					const created = yield* dns.createRecord(name, type, content).pipe(Effect.result);
					records = yield* observe(dns.listRecords(name));
					if (records.length === 0)
						return yield* Result.isFailure(created) ? failedMutation(created.failure) : problem("pending");
				}
				if (
					records.length !== 1 ||
					records.some(
						(record) =>
							record.name !== name ||
							record.type !== type ||
							(type === "A" ? record.proxied !== false : record.proxied === true) ||
							(record.content !== content && !(type === "TXT" && record.content === `"${content}"`)),
					)
				)
					return yield* problem("conflict");
			});
		yield* ensureRecord(hostname, "A", address);
		yield* ensureRecord(
			certificate.dns_requirements.ownership.name,
			"TXT",
			certificate.dns_requirements.ownership.app_value,
		);
		const checked = yield* observe(fly.checkCertificate(appName, hostname));
		yield* assertCertificate(checked);
		if (
			!checked.configured ||
			checked.status !== "active" ||
			!checked.validation.ownership_txt_configured ||
			!checked.certificates.some((entry) => entry.source === "fly" && entry.status === "active") ||
			checked.dns_records.a?.length !== 1 ||
			checked.dns_records.a[0] !== address ||
			(checked.dns_records.aaaa?.length ?? 0) !== 0
		)
			return yield* problem("pending");
	});
