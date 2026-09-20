import { Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { FlyBoardApi, flyBoardApiLayer } from "../src/fly-board-api.ts";
import type { FlyMachineConfig } from "../src/fly-model.ts";

const settings = { token: Redacted.make("private-fly-token"), baseUrl: "https://fly.test" };
const app = { id: "app-id", name: "chirp-board", network: "chirp-board", organization: { slug: "org" } };
const appDetails = { id: app.id, name: app.name, status: "pending", organization: app.organization };
const appList = { total_apps: 1, apps: [{ id: app.id, name: app.name, network: app.network }] };
const volume = {
	id: "vol-id",
	name: "chirp_data_board",
	state: "created",
	region: "sjc",
	encrypted: true,
	size_gb: 1,
	auto_backup_enabled: true,
	fstype: "ext4",
};
const config: FlyMachineConfig = {
	image: `registry.example/chirp@sha256:${"a".repeat(64)}`,
	env: { RP_ID: "board.test", PUBLIC_ORIGIN: "https://board.test" },
	metadata: { deployment: "deployment-id" },
	mounts: [{ volume: "vol-id", path: "/data" }],
	guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
	services: [
		{
			protocol: "tcp",
			internal_port: 8080,
			autostart: true,
			autostop: "stop",
			min_machines_running: 0,
			ports: [{ port: 443, handlers: ["tls", "http"] }],
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
};
const machine = {
	id: "machine-id",
	name: "board-machine",
	state: "stopped",
	region: "sjc",
	instance_id: "version-1",
	config,
};

const jsonBody = (request: { readonly body: { readonly _tag: string } }) => {
	if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
	if (!("body" in request.body) || !(request.body.body instanceof Uint8Array)) throw new Error("Expected bytes");
	return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(request.body.body));
};

const run = <A, E>(effect: Effect.Effect<A, E, FlyBoardApi>, handle: Parameters<typeof HttpClient.make>[0]) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				flyBoardApiLayer(settings).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle)))),
			),
		),
	);

describe("FlyBoardApi", () => {
	test("times out stalled mutation bodies without leaking partial provider data", async () => {
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				const pending = yield* api.allocateSharedIp("chirp-board").pipe(Effect.result, Effect.forkChild);
				yield* TestClock.adjust("76 seconds");
				expect(pending.pollUnsafe()).toBeDefined();
				const result = yield* Fiber.join(pending);
				expect(result).toMatchObject({
					failure: { operation: "allocate_shared_ip", reason: "transport", status: null },
				});
				expect(JSON.stringify(result)).not.toContain("private-provider-data");
			}).pipe(Effect.provide(TestClock.layer())),
			(request, _url, signal) => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"private":"private-provider-data"'));
						signal.addEventListener("abort", () => controller.error(new Error("private-provider-data")), {
							once: true,
						});
					},
				});
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response(stream, { headers: { "content-type": "application/json" } }),
					),
				);
			},
		);
	});

	test("uses current Machines REST IP and certificate contracts", async () => {
		const seen: Array<{ method: string; url: string; body?: Schema.Json }> = [];
		const ip = { ip: "66.241.124.100", shared: true };
		const certificate = {
			hostname: "board.boards.chirp.wiki",
			acme_requested: true,
			configured: true,
			status: "active",
			certificates: [{ source: "fly", status: "active" }],
			validation: { ownership_txt_configured: true },
			dns_requirements: {
				a: [ip.ip],
				ownership: { name: "_fly-ownership.board.boards.chirp.wiki", app_value: "app-123" },
			},
		};
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				expect(yield* api.listIpAssignments("chirp-board")).toEqual([ip]);
				expect(yield* api.allocateSharedIp("chirp-board")).toEqual(ip);
				expect(Option.getOrThrow(yield* api.getCertificate("chirp-board", certificate.hostname))).toEqual(certificate);
				expect(yield* api.createCertificate("chirp-board", certificate.hostname)).toEqual(certificate);
				expect(yield* api.checkCertificate("chirp-board", certificate.hostname)).toEqual({
					...certificate,
					dns_records: { a: [ip.ip], aaaa: null },
				});
			}),
			(request) => {
				expect(request.headers.authorization).toBe("Bearer private-fly-token");
				seen.push({
					method: request.method,
					url: request.url,
					...(request.body._tag === "Uint8Array" ? { body: jsonBody(request) } : {}),
				});
				const value = request.url.endsWith("ip_assignments")
					? request.method === "GET"
						? { ips: [ip] }
						: ip
					: request.url.endsWith("/check")
						? { ...certificate, dns_records: { a: [ip.ip], aaaa: null } }
						: certificate;
				return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value)));
			},
		);
		expect(seen).toEqual([
			{ method: "GET", url: "https://fly.test/v1/apps/chirp-board/ip_assignments" },
			{ method: "POST", url: "https://fly.test/v1/apps/chirp-board/ip_assignments", body: { type: "shared_v4" } },
			{ method: "GET", url: `https://fly.test/v1/apps/chirp-board/certificates/${certificate.hostname}` },
			{
				method: "POST",
				url: "https://fly.test/v1/apps/chirp-board/certificates/acme",
				body: { hostname: certificate.hostname },
			},
			{ method: "POST", url: `https://fly.test/v1/apps/chirp-board/certificates/${certificate.hostname}/check` },
		]);
	});

	test("treats missing certificates as absent but preserves certificate conflicts and rate limits", async () => {
		expect(
			Option.isNone(
				await run(
					FlyBoardApi.use((api) => api.getCertificate("app", "board.test")),
					(request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
				),
			),
		).toBe(true);
		for (const status of [409, 429, 503]) {
			const result = await run(
				Effect.result(FlyBoardApi.use((api) => api.createCertificate("app", "board.test"))),
				(request) =>
					Effect.succeed(HttpClientResponse.fromWeb(request, new Response("secret-provider-body", { status }))),
			);
			expect(result).toMatchObject({ failure: { reason: "status", status } });
			expect(JSON.stringify(result)).not.toContain("secret-provider-body");
		}
	});

	test("sends authenticated create requests with the exact safe shape", async () => {
		const seen: Array<{ readonly method: string; readonly url: string; readonly body: Schema.Json }> = [];
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				yield* api.createApp({ name: "chirp-board", organization: "org", network: "chirp-board" });
				expect(
					yield* api.createVolume({ appName: "chirp-board", name: "chirp_data_board", region: "sjc", sizeGb: 1 }),
				).toEqual(volume);
			}),
			(request) => {
				expect(request.headers.authorization).toBe("Bearer private-fly-token");
				expect(JSON.stringify(request)).not.toContain("private-fly-token");
				seen.push({ method: request.method, url: request.url, body: jsonBody(request) });
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						request.url.endsWith("/volumes")
							? Response.json(volume)
							: Response.json({ id: app.id, created_at: 1_708_631_799_000 }, { status: 201 }),
					),
				);
			},
		);
		expect(seen).toEqual([
			{
				method: "POST",
				url: "https://fly.test/v1/apps",
				body: { app_name: "chirp-board", org_slug: "org", network: "chirp-board", enable_subdomains: false },
			},
			{
				method: "POST",
				url: "https://fly.test/v1/apps/chirp-board/volumes",
				body: {
					name: "chirp_data_board",
					region: "sjc",
					size_gb: 1,
					encrypted: true,
					auto_backup_enabled: true,
					fstype: "ext4",
				},
			},
		]);
	});

	test("maps missing reads to none and sanitizes schema failures", async () => {
		const missing = await run(
			FlyBoardApi.use((api) => api.getApp("missing")),
			(request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
		);
		expect(Option.isNone(missing)).toBe(true);
		const invalid = await run(Effect.exit(FlyBoardApi.use((api) => api.getApp("broken"))), (request) =>
			Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ private: "do-not-report" }, { status: 200 }))),
		);
		expect(Exit.isFailure(invalid)).toBe(true);
		expect(invalid.toString()).not.toContain("do-not-report");
		expect(invalid.toString()).not.toContain("private-fly-token");
	});

	test("does not retry an ambiguous mutation failure", async () => {
		let attempts = 0;
		const result = await run(
			Effect.exit(
				FlyBoardApi.use((api) => api.createApp({ name: "chirp-board", organization: "org", network: "network" })),
			),
			(request) => {
				attempts += 1;
				return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })));
			},
		);
		expect(Exit.isFailure(result)).toBe(true);
		expect(attempts).toBe(1);
	});

	test("passes wait versions and exposes no delete operations", async () => {
		const requests: Array<{ readonly url: string; readonly body?: Schema.Json }> = [];
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				yield* api.waitMachine("chirp-board", "machine-id", "started", "version-2");
				expect("deleteApp" in api).toBe(false);
				expect("deleteMachine" in api).toBe(false);
				expect("deleteVolume" in api).toBe(false);
				expect("listSecrets" in api).toBe(false);
				expect("updateSecrets" in api).toBe(false);
			}),
			(request) => {
				requests.push({
					url: request.url,
					...(request.method === "POST" ? { body: jsonBody(request) } : {}),
				});
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						request.url.includes("/wait")
							? Response.json({ ok: true, state: "started", version: "version-2" })
							: Response.json({ ...machine, instance_id: "version-2" }),
					),
				);
			},
		);
		expect(requests[0]?.url).toBe(
			"https://fly.test/v1/apps/chirp-board/machines/machine-id/wait?state=started&version=version-2&timeout=60",
		);
	});

	test("decodes provider observations", async () => {
		const urls: string[] = [];
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				expect(Option.getOrThrow(yield* api.getApp("chirp-board"))).toEqual(app);
				expect(yield* api.listVolumes("chirp-board")).toEqual([volume]);
				expect(yield* api.listMachines("chirp-board")).toEqual([machine]);
			}),
			(request) => {
				urls.push(request.url);
				const value = request.url.endsWith("/volumes")
					? [volume]
					: request.url.endsWith("/machines")
						? [machine]
						: request.url.includes("?org_slug=")
							? appList
							: appDetails;
				return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value)));
			},
		);
		expect(urls.slice(0, 2)).toEqual(["https://fly.test/v1/apps/chirp-board", "https://fly.test/v1/apps?org_slug=org"]);
	});

	test("consumes provider JSON before the scoped request is released", async () => {
		const decoded = await run(
			FlyBoardApi.use((api) => api.getApp("chirp-board")),
			(request, _url, signal) => {
				const value = request.url.includes("?org_slug=") ? appList : appDetails;
				const stream = new ReadableStream<Uint8Array>({
					pull: async (controller) => {
						await Promise.resolve();
						if (signal.aborted) return controller.error(new Error("response scope closed before body consumption"));
						controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
						controller.close();
					},
				});
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response(stream, { headers: { "content-type": "application/json" } }),
					),
				);
			},
		);
		expect(Option.getOrThrow(decoded)).toEqual(app);
	});

	test("lists volume snapshots without requesting secret material", async () => {
		const snapshots = [
			{
				id: "snapshot-id",
				status: "created",
				created_at: "2026-09-20T12:00:00.000Z",
				digest: "sha256:snapshot",
				retention_days: 5,
			},
		];
		const urls: string[] = [];
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				expect(yield* api.listVolumeSnapshots("chirp-board", "volume-id")).toEqual(snapshots);
			}),
			(request) => {
				urls.push(request.url);
				return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(snapshots)));
			},
		);
		expect(urls).toEqual(["https://fly.test/v1/apps/chirp-board/volumes/volume-id/snapshots"]);
	});
});
