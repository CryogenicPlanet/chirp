import { Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
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

	test("passes current and wait versions and exposes no delete operations", async () => {
		const requests: Array<{ readonly url: string; readonly body?: Schema.Json }> = [];
		await run(
			Effect.gen(function* () {
				const api = yield* FlyBoardApi;
				yield* api.updateMachine({
					appName: "chirp-board",
					machineId: "machine-id",
					name: "board-machine",
					region: "sjc",
					config,
					currentVersion: "version-1",
				});
				yield* api.waitMachine("chirp-board", "machine-id", "started", "version-2");
				expect("deleteApp" in api).toBe(false);
				expect("deleteMachine" in api).toBe(false);
				expect("deleteVolume" in api).toBe(false);
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
		expect(requests[0]?.body).toMatchObject({ current_version: "version-1" });
		expect(requests[1]?.url).toBe(
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
				expect(yield* api.listSecrets("chirp-board")).toEqual([]);
			}),
			(request) => {
				urls.push(request.url);
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json(request.url.includes("/snapshots") ? snapshots : { secrets: [] }),
					),
				);
			},
		);
		expect(urls).toEqual([
			"https://fly.test/v1/apps/chirp-board/volumes/volume-id/snapshots",
			"https://fly.test/v1/apps/chirp-board/secrets?show_secrets=false",
		]);
	});
});
