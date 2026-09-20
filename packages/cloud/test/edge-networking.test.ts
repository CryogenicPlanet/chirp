import { Effect, Layer, Result } from "effect";
import { describe, expect, test } from "vitest";
import { CloudflareDns } from "../src/cloudflare-dns.ts";
import { type EdgeMutation, ensureEdgeNetworking } from "../src/edge-networking.ts";
import { FlyApiError, FlyBoardApi } from "../src/fly-board-api.ts";
import { makeNetworking } from "./fixtures/edge-networking.ts";

const hostname = "board.boards.chirp.wiki";
const run = (provider: ReturnType<typeof makeNetworking>, renew = Effect.void, blockedMutation?: EdgeMutation) => {
	const pending = new Set(blockedMutation === undefined ? [] : [blockedMutation]);
	return Effect.runPromise(
		ensureEdgeNetworking("chirp-board", hostname, renew, {
			isPending: (mutation) => pending.has(mutation),
			mark: (mutation) => Effect.sync(() => pending.add(mutation)),
			clear: (mutation) => Effect.sync(() => pending.delete(mutation)),
		}).pipe(
			Effect.result,
			Effect.provide(
				Layer.mergeAll(Layer.succeed(FlyBoardApi, provider.fly), Layer.succeed(CloudflareDns, provider.dns)),
			),
		),
	);
};

describe("edge networking reconciliation", () => {
	test("adopts matching resources on replay and creates only DNS-only exact records", async () => {
		const provider = makeNetworking();
		expect(Result.isSuccess(await run(provider))).toBe(true);
		expect(provider.state.records).toMatchObject([
			{ name: hostname, type: "A", content: "66.241.124.100", proxied: false },
			{ name: `_fly-ownership.${hostname}`, type: "TXT", content: "app-123", proxied: false },
		]);
		provider.state.calls.length = 0;
		expect(Result.isSuccess(await run(provider))).toBe(true);
		expect(provider.state.calls.some((call) => call.startsWith("create") || call === "allocate_ip")).toBe(false);
	});

	test.each([403, 409, 429, 503])(
		"classifies allocation HTTP %s without blindly repeating the mutation",
		async (status) => {
			const provider = makeNetworking();
			provider.fly.allocateSharedIp = () =>
				Effect.fail(new FlyApiError({ operation: "allocate_ip", reason: "status", status }));
			expect(await run(provider)).toMatchObject({
				failure: { reason: status === 403 ? "rejected" : "ambiguous", mutation: status === 403 ? null : "ip" },
			});
			expect(provider.state.calls).toEqual(["list_ips", "list_ips"]);
			expect(provider.state.records).toEqual([]);
		},
	);

	test.each([
		{ operation: "allocate_ip", mutation: "ip" },
		{ operation: "create_certificate", mutation: "certificate" },
		{ operation: "create:A", mutation: "a_record" },
		{ operation: "create:TXT", mutation: "txt_record" },
	] as const)("does not repeat an unobserved $operation mutation", async ({ operation, mutation }) => {
		const provider = makeNetworking();
		provider.state.failBefore.add(operation);
		expect(await run(provider)).toMatchObject({ failure: { reason: "ambiguous", mutation } });
		expect(await run(provider, Effect.void, mutation)).toMatchObject({ failure: { reason: "ambiguous", mutation } });
		expect(provider.state.calls.filter((call) => call === operation)).toHaveLength(1);
	});

	test("refuses duplicate or malformed shared IPs without allocating another", async () => {
		for (const ips of [
			[
				{ ip: "66.241.124.100", shared: true },
				{ ip: "66.241.124.101", shared: true },
			],
			[{ ip: "invalid-ip", shared: true }],
			[{ ip: "66.241.124.100", shared: true, egress: true }],
		]) {
			const provider = makeNetworking();
			provider.state.ips = ips;
			expect(await run(provider)).toMatchObject({ failure: { reason: "conflict" } });
			expect(provider.state.calls).toEqual(["list_ips"]);
		}
	});

	test("refuses certificate identity drift before changing DNS", async () => {
		for (const conflict of ["hostname", "ownership", "address", "custom"]) {
			const provider = makeNetworking();
			await Effect.runPromise(provider.fly.createCertificate("chirp-board", hostname));
			const certificate = provider.state.certificate!;
			provider.state.certificate = {
				...certificate,
				...(conflict === "hostname" ? { hostname: "other.board.test" } : {}),
				...(conflict === "ownership"
					? {
							dns_requirements: {
								...certificate.dns_requirements,
								ownership: { name: "_fly-ownership.other.wiki", app_value: "app-123" },
							},
						}
					: {}),
				...(conflict === "address" ? { dns_requirements: { ...certificate.dns_requirements, a: ["192.0.2.1"] } } : {}),
				...(conflict === "custom" ? { certificates: [{ source: "custom", status: "active" }] } : {}),
			};
			expect(await run(provider)).toMatchObject({ failure: { reason: "conflict" } });
			expect(provider.state.calls).not.toContain("create:A");
		}
	});

	test.each(["allocate_ip", "create_certificate", "create:A", "create:TXT"])(
		"adopts a committed %s after a lost response",
		async (operation) => {
			const provider = makeNetworking();
			provider.state.failAfter.add(operation);
			expect(Result.isSuccess(await run(provider))).toBe(true);
			expect(Result.isSuccess(await run(provider))).toBe(true);
			expect(provider.state.calls.filter((call) => call === operation)).toHaveLength(1);
		},
	);

	test.each(["list_ips", "get_certificate", "get_zone", `list:${hostname}`, "check_certificate"])(
		"retries transient %s observations without duplicating resources",
		async (operation) => {
			const provider = makeNetworking();
			provider.state.failBefore.add(operation);
			expect(await run(provider)).toMatchObject({ failure: { reason: "unavailable" } });
			expect(Result.isSuccess(await run(provider))).toBe(true);
			expect(provider.state.ips).toHaveLength(1);
			expect(provider.state.records).toHaveLength(2);
		},
	);

	test("recovers when DNS write commits but the observation fails", async () => {
		const provider = makeNetworking();
		const create = provider.dns.createRecord;
		provider.dns.createRecord = (name, type, content) =>
			create(name, type, content).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						if (type === "A") provider.state.failBefore.add(`list:${name}`);
					}),
				),
			);
		expect(await run(provider)).toMatchObject({ failure: { reason: "ambiguous", mutation: "a_record" } });
		expect(Result.isSuccess(await run(provider, Effect.void, "a_record"))).toBe(true);
		expect(provider.state.calls.filter((call) => call === "create:A")).toHaveLength(1);
	});

	test.each([
		{ type: "A", content: "192.0.2.1", proxied: false },
		{ type: "A", content: "66.241.124.100", proxied: true },
		{ type: "AAAA", content: "2001:db8::1", proxied: false },
		{ type: "CNAME", content: "other.fly.dev", proxied: false },
		{ type: "TXT", content: "unrelated", proxied: false },
	])("refuses conflicting exact DNS without overwriting it: $type $content $proxied", async (record) => {
		const provider = makeNetworking();
		provider.state.records.push({ id: "foreign", name: hostname, ...record });
		expect(await run(provider)).toMatchObject({ failure: { reason: "conflict" } });
		expect(provider.state.records).toEqual([{ id: "foreign", name: hostname, ...record }]);
		expect(provider.state.calls).not.toContain("create:A");
	});

	test("refuses duplicate matching DNS and conflicting ownership TXT", async () => {
		for (const conflict of ["duplicate", "ownership"]) {
			const provider = makeNetworking();
			expect(Result.isSuccess(await run(provider))).toBe(true);
			if (conflict === "duplicate") provider.state.records.push({ ...provider.state.records[0]!, id: "duplicate" });
			else provider.state.records[1] = { ...provider.state.records[1]!, content: "app-other" };
			expect(await run(provider)).toMatchObject({ failure: { reason: "conflict" } });
		}
	});

	test("does not write to an unrelated, inactive, or delegated zone", async () => {
		for (const conflict of ["unrelated", "inactive", "delegated", "partial"]) {
			const provider = makeNetworking();
			if (conflict === "unrelated") provider.state.zone.name = "other.wiki";
			if (conflict === "inactive") provider.state.zone.status = "pending";
			if (conflict === "partial") provider.state.zone.type = "partial";
			if (conflict === "delegated")
				provider.state.records.push({ id: "ns", name: "boards.chirp.wiki", type: "NS", content: "ns.example.com" });
			expect(await run(provider)).toMatchObject({ failure: { reason: "conflict" } });
			expect(provider.state.calls).not.toContain("create:A");
		}
	});

	test("waits for certificate issuance and observed DNS rather than accepting stale status", async () => {
		const provider = makeNetworking();
		provider.state.ready = false;
		expect(await run(provider)).toMatchObject({ failure: { reason: "pending" } });
		provider.state.ready = true;
		provider.state.resolved = ["192.0.2.1"];
		expect(await run(provider)).toMatchObject({ failure: { reason: "pending" } });
		provider.state.resolved = ["66.241.124.100"];
		expect(Result.isSuccess(await run(provider))).toBe(true);
	});

	test("renews the lease before every call and stops immediately on lease loss", async () => {
		const provider = makeNetworking();
		const renewed = Effect.sync(() => {
			provider.state.calls.push("renew");
		});
		expect(Result.isSuccess(await run(provider, renewed))).toBe(true);
		for (let index = 0; index < provider.state.calls.length; index += 2)
			expect(provider.state.calls[index]).toBe("renew");
		provider.state.calls.length = 0;
		await expect(run(provider, Effect.die("lost lease"))).rejects.toThrow("lost lease");
		expect(provider.state.calls).toEqual([]);
	});
});
