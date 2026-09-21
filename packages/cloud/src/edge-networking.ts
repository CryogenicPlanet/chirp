import { isIPv4 } from "node:net";
import { Data, Effect, Option, Result } from "effect";
import { type CloudflareApiError, CloudflareDns } from "./cloudflare-dns.ts";
import { type FlyApiError, FlyBoardApi } from "./fly-board-api.ts";
import type { FlyCertificate, FlyIpAssignment } from "./fly-model.ts";

export type EdgeMutation = "ip" | "certificate" | "a_record" | "txt_record";

export interface EdgeMutationJournal<E, R> {
	readonly isPending: (mutation: EdgeMutation) => boolean;
	readonly mark: (mutation: EdgeMutation) => Effect.Effect<unknown, E, R>;
	readonly clear: (mutation: EdgeMutation) => Effect.Effect<unknown, E, R>;
}

export class EdgeNetworkingError extends Data.TaggedError("EdgeNetworkingError")<{
	readonly reason: "pending" | "ambiguous" | "conflict" | "rejected" | "unavailable" | "unsupported";
	readonly mutation: EdgeMutation | null;
}> {}

const problem = (reason: EdgeNetworkingError["reason"], mutation: EdgeMutation | null = null) =>
	new EdgeNetworkingError({ reason, mutation });
const failedMutation = (error: FlyApiError | CloudflareApiError, mutation: EdgeMutation) =>
	error.reason === "decode"
		? problem("unsupported")
		: error.reason === "status" && error.status === 404
			? problem("pending", mutation)
			: error.reason === "status" &&
				  error.status !== null &&
				  error.status >= 400 &&
				  error.status < 500 &&
				  ![408, 409, 425, 429].includes(error.status)
				? problem("rejected")
				: problem("ambiguous", mutation);

export const ensureEdgeNetworking = <E, R, E2, R2>(
	appName: string,
	hostname: string,
	renewLease: Effect.Effect<unknown, E, R>,
	journal: EdgeMutationJournal<E2, R2>,
) =>
	Effect.gen(function* () {
		const fly = yield* FlyBoardApi;
		const dns = yield* CloudflareDns;
		const observe = <A>(effect: Effect.Effect<A, FlyApiError | CloudflareApiError>) =>
			renewLease.pipe(
				Effect.andThen(
					effect.pipe(
						Effect.mapError((error) =>
							error.reason === "decode"
								? problem("unsupported")
								: error.reason === "status" && [401, 403].includes(error.status ?? 0)
									? problem("rejected")
									: error.reason === "status" && error.status === 404
										? problem("pending")
										: problem("unavailable"),
						),
					),
				),
			);
		const observeAfterMutation = <A>(
			effect: Effect.Effect<A, FlyApiError | CloudflareApiError>,
			mutation: EdgeMutation,
		) =>
			observe(effect).pipe(
				Effect.catchIf(
					(error): error is EdgeNetworkingError => error instanceof EdgeNetworkingError,
					(error) =>
						Effect.fail(
							["rejected", "unsupported", "pending"].includes(error.reason) ? error : problem("ambiguous", mutation),
						),
				),
			);
		const shared = (ips: ReadonlyArray<FlyIpAssignment>) => ips.filter((ip) => ip.shared);
		let ips = shared(yield* observe(fly.listIpAssignments(appName)));
		if (ips.length === 0) {
			if (journal.isPending("ip")) return yield* problem("pending", "ip");
			yield* renewLease;
			yield* journal.mark("ip");
			yield* renewLease;
			const created = yield* fly.allocateSharedIp(appName).pipe(Effect.result);
			if (Result.isFailure(created) && failedMutation(created.failure, "ip").reason === "rejected") {
				yield* journal.clear("ip");
				return yield* problem("rejected");
			}
			ips = shared(yield* observeAfterMutation(fly.listIpAssignments(appName), "ip"));
			if (ips.length === 0) {
				return yield* Result.isFailure(created) ? failedMutation(created.failure, "ip") : problem("ambiguous", "ip");
			}
		}
		if (ips.length !== 1 || ips[0]!.egress || !isIPv4(ips[0]!.ip)) return yield* problem("conflict");
		if (journal.isPending("ip")) yield* journal.clear("ip");
		const address = ips[0]!.ip;
		let found = yield* observe(fly.getCertificate(appName, hostname));
		if (Option.isNone(found)) {
			if (journal.isPending("certificate")) return yield* problem("pending", "certificate");
			yield* renewLease;
			yield* journal.mark("certificate");
			yield* renewLease;
			const created = yield* fly.createCertificate(appName, hostname).pipe(Effect.result);
			if (Result.isFailure(created) && failedMutation(created.failure, "certificate").reason === "rejected") {
				yield* journal.clear("certificate");
				return yield* problem("rejected");
			}
			found = yield* observeAfterMutation(fly.getCertificate(appName, hostname), "certificate");
			if (Option.isNone(found)) {
				return yield* Result.isFailure(created)
					? failedMutation(created.failure, "certificate")
					: problem("ambiguous", "certificate");
			}
		}
		const assertCertificate = (certificate: FlyCertificate) =>
			Effect.gen(function* () {
				if (certificate.hostname !== hostname || certificate.acme_requested === false)
					return yield* problem("conflict");
				if (certificate.acme_requested !== true || certificate.certificates == null) return yield* problem("pending");
				if (certificate.certificates.some((entry) => entry.source === "custom")) return yield* problem("conflict");
				const addresses = certificate.dns_requirements?.a;
				const ownership = certificate.dns_requirements?.ownership;
				if (addresses == null || ownership?.name == null || ownership.app_value == null)
					return yield* problem("pending");
				if (
					!addresses.includes(address) ||
					ownership.name !== `_fly-ownership.${hostname}` ||
					!/^app-[a-zA-Z0-9]+$/.test(ownership.app_value)
				)
					return yield* problem("conflict");
				return { ownershipName: ownership.name, ownershipValue: ownership.app_value };
			});
		const { ownershipName, ownershipValue } = yield* assertCertificate(found.value);
		if (journal.isPending("certificate")) yield* journal.clear("certificate");
		const zone = yield* observe(dns.getZone);
		if (zone.type !== "full" || !hostname.endsWith(`.${zone.name}`)) return yield* problem("conflict");
		if (zone.status !== "active") return yield* problem("pending");
		let parent = hostname.slice(hostname.indexOf(".") + 1);
		while (parent !== zone.name) {
			const records = yield* observe(dns.listRecords(parent));
			if (records.some((record) => record.type === "NS" || record.type === "CNAME")) return yield* problem("pending");
			parent = parent.slice(parent.indexOf(".") + 1);
		}
		const ensureRecord = (name: string, type: "A" | "TXT", content: string, mutation: EdgeMutation) =>
			Effect.gen(function* () {
				let records = yield* observe(dns.listRecords(name));
				if (records.length === 0) {
					if (journal.isPending(mutation)) return yield* problem("pending", mutation);
					yield* renewLease;
					yield* journal.mark(mutation);
					yield* renewLease;
					const created = yield* dns.createRecord(name, type, content).pipe(Effect.result);
					if (Result.isFailure(created) && failedMutation(created.failure, mutation).reason === "rejected") {
						yield* journal.clear(mutation);
						return yield* problem("rejected");
					}
					records = yield* observeAfterMutation(dns.listRecords(name), mutation);
					if (records.length === 0) {
						return yield* Result.isFailure(created)
							? failedMutation(created.failure, mutation)
							: problem("ambiguous", mutation);
					}
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
					return yield* problem("pending");
				if (journal.isPending(mutation)) yield* journal.clear(mutation);
			});
		yield* ensureRecord(hostname, "A", address, "a_record");
		yield* ensureRecord(ownershipName, "TXT", ownershipValue, "txt_record");
		const checked = yield* observe(fly.checkCertificate(appName, hostname));
		yield* assertCertificate(checked);
		const records = checked.dns_records;
		if (
			checked.configured !== true ||
			checked.status !== "active" ||
			checked.validation?.ownership_txt_configured !== true ||
			!checked.certificates?.some((entry) => entry.source === "fly" && entry.status === "active") ||
			records?.a?.length !== 1 ||
			records.a[0] !== address ||
			(records.aaaa !== null && records.aaaa?.length !== 0)
		)
			return yield* problem("pending");
	});
