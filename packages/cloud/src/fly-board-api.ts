import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
	FlyAppCreated,
	FlyAppDetails,
	FlyApps,
	FlyCertificate,
	FlyCertificateCheck,
	FlyIpAssignment,
	FlyIpAssignments,
	FlyMachine,
	type FlyMachineConfig,
	FlyVolume,
	FlyVolumeSnapshot,
	FlyWaitResult,
} from "./fly-model.ts";

export interface FlyApiSettings {
	readonly token: Redacted.Redacted;
	readonly baseUrl?: string;
}

export class FlyApiError extends Data.TaggedError("FlyApiError")<{
	readonly operation: string;
	readonly reason: "transport" | "status" | "decode";
	readonly status: number | null;
}> {}

export interface CreateFlyApp {
	readonly name: string;
	readonly organization: string;
	readonly network: string;
}

export interface CreateFlyVolume {
	readonly appName: string;
	readonly name: string;
	readonly region: string;
	readonly sizeGb: number;
}

export interface CreateFlyMachine {
	readonly appName: string;
	readonly name: string;
	readonly region: string;
	readonly config: FlyMachineConfig;
}

const make = (settings: FlyApiSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const baseUrl = settings.baseUrl ?? "https://api.machines.dev";
		const segment = encodeURIComponent;
		const request = (method: "GET" | "POST", path: string) =>
			HttpClientRequest.make(method)(new URL(path, baseUrl).href).pipe(
				HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`),
				HttpClientRequest.setHeader("accept", "application/json"),
			);
		const send = <A>(
			operation: string,
			outgoing: HttpClientRequest.HttpClientRequest,
			consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, FlyApiError>,
		) =>
			Effect.scoped(
				HttpClient.withScope(client)
					.execute(outgoing)
					.pipe(
						Effect.mapError(() => new FlyApiError({ operation, reason: "transport", status: null })),
						Effect.flatMap(consume),
						Effect.timeout("75 seconds"),
						Effect.catchTag("TimeoutError", () =>
							Effect.fail(new FlyApiError({ operation, reason: "transport", status: null })),
						),
					),
			);
		const successful = (
			operation: string,
			response: HttpClientResponse.HttpClientResponse,
		): Effect.Effect<HttpClientResponse.HttpClientResponse, FlyApiError> =>
			response.status >= 200 && response.status < 300
				? Effect.succeed(response)
				: Effect.fail(new FlyApiError({ operation, reason: "status", status: response.status }));
		const decode = <A, I>(
			operation: string,
			schema: Schema.Codec<A, I>,
			response: HttpClientResponse.HttpClientResponse,
		) =>
			HttpClientResponse.schemaBodyJson(schema)(response).pipe(
				Effect.mapError(
					(error) =>
						new FlyApiError({
							operation,
							reason: error._tag === "SchemaError" ? "decode" : "transport",
							status: response.status,
						}),
				),
			);
		const discard = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
			successful(operation, response).pipe(
				Effect.flatMap((found) =>
					found.arrayBuffer.pipe(
						Effect.mapError(() => new FlyApiError({ operation, reason: "transport", status: response.status })),
					),
				),
				Effect.asVoid,
			);
		const json = <A, I>(operation: string, schema: Schema.Codec<A, I>, outgoing: HttpClientRequest.HttpClientRequest) =>
			send(operation, outgoing, (response) =>
				successful(operation, response).pipe(Effect.flatMap((found) => decode(operation, schema, found))),
			);
		const optional = <A, I>(
			operation: string,
			schema: Schema.Codec<A, I>,
			outgoing: HttpClientRequest.HttpClientRequest,
		) =>
			send(operation, outgoing, (response) =>
				response.status === 404
					? Effect.succeed(Option.none<A>())
					: successful(operation, response).pipe(
							Effect.flatMap((found) => decode(operation, schema, found)),
							Effect.asSome,
						),
			);
		const body = (outgoing: HttpClientRequest.HttpClientRequest, value: Schema.Json) =>
			HttpClientRequest.bodyJson(outgoing, value).pipe(
				Effect.mapError(() => new FlyApiError({ operation: "encode", reason: "decode", status: null })),
			);
		return {
			listIpAssignments: (appName: string) =>
				json(
					"list_ip_assignments",
					FlyIpAssignments,
					request("GET", `/v1/apps/${segment(appName)}/ip_assignments`),
				).pipe(Effect.map((result) => result.ips)),
			allocateSharedIp: (appName: string) =>
				body(request("POST", `/v1/apps/${segment(appName)}/ip_assignments`), { type: "shared_v4" }).pipe(
					Effect.flatMap((outgoing) => json("allocate_shared_ip", FlyIpAssignment, outgoing)),
				),
			getCertificate: (appName: string, hostname: string) =>
				optional(
					"get_certificate",
					FlyCertificate,
					request("GET", `/v1/apps/${segment(appName)}/certificates/${segment(hostname)}`),
				),
			createCertificate: (appName: string, hostname: string) =>
				body(request("POST", `/v1/apps/${segment(appName)}/certificates/acme`), { hostname }).pipe(
					Effect.flatMap((outgoing) => json("create_certificate", FlyCertificate, outgoing)),
				),
			checkCertificate: (appName: string, hostname: string) =>
				json(
					"check_certificate",
					FlyCertificateCheck,
					request("POST", `/v1/apps/${segment(appName)}/certificates/${segment(hostname)}/check`),
				),
			getApp: (appName: string) =>
				optional("get_app", FlyAppDetails, request("GET", `/v1/apps/${segment(appName)}`)).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeedNone,
							onSome: (details) => {
								const query = new URLSearchParams({ org_slug: details.organization.slug });
								return json("list_apps", FlyApps, request("GET", `/v1/apps?${query.toString()}`)).pipe(
									Effect.flatMap((listed) => {
										const match = listed.apps.find((app) => app.id === details.id && app.name === details.name);
										return match
											? Effect.succeedSome({ ...details, network: match.network })
											: Effect.fail(new FlyApiError({ operation: "list_apps", reason: "decode", status: 200 }));
									}),
								);
							},
						}),
					),
				),
			createApp: (input: CreateFlyApp) =>
				body(request("POST", "/v1/apps"), {
					app_name: input.name,
					org_slug: input.organization,
					network: input.network,
					enable_subdomains: false,
				}).pipe(
					Effect.flatMap((outgoing) => json("create_app", FlyAppCreated, outgoing)),
					Effect.asVoid,
				),
			listVolumes: (appName: string) =>
				json("list_volumes", Schema.Array(FlyVolume), request("GET", `/v1/apps/${segment(appName)}/volumes`)),
			getVolume: (appName: string, volumeId: string) =>
				optional("get_volume", FlyVolume, request("GET", `/v1/apps/${segment(appName)}/volumes/${segment(volumeId)}`)),
			createVolume: (input: CreateFlyVolume) =>
				body(request("POST", `/v1/apps/${segment(input.appName)}/volumes`), {
					name: input.name,
					region: input.region,
					size_gb: input.sizeGb,
					encrypted: true,
					auto_backup_enabled: true,
					fstype: "ext4",
				}).pipe(Effect.flatMap((outgoing) => json("create_volume", FlyVolume, outgoing))),
			listMachines: (appName: string) =>
				json("list_machines", Schema.Array(FlyMachine), request("GET", `/v1/apps/${segment(appName)}/machines`)),
			getMachine: (appName: string, machineId: string) =>
				optional(
					"get_machine",
					FlyMachine,
					request("GET", `/v1/apps/${segment(appName)}/machines/${segment(machineId)}`),
				),
			createMachine: (input: CreateFlyMachine) =>
				body(request("POST", `/v1/apps/${segment(input.appName)}/machines`), {
					name: input.name,
					region: input.region,
					config: input.config,
					skip_launch: true,
				}).pipe(Effect.flatMap((outgoing) => json("create_machine", FlyMachine, outgoing))),
			startMachine: (appName: string, machineId: string) =>
				send(
					"start_machine",
					request("POST", `/v1/apps/${segment(appName)}/machines/${segment(machineId)}/start`),
					(response) => discard("start_machine", response),
				),
			waitMachine: (appName: string, machineId: string, state: "started", version: string) => {
				const query = new URLSearchParams({ state, version, timeout: "60" });
				return json(
					"wait_machine",
					FlyWaitResult,
					request("GET", `/v1/apps/${segment(appName)}/machines/${segment(machineId)}/wait?${query.toString()}`),
				);
			},
			listVolumeSnapshots: (appName: string, volumeId: string) =>
				json(
					"list_volume_snapshots",
					Schema.Array(FlyVolumeSnapshot),
					request("GET", `/v1/apps/${segment(appName)}/volumes/${segment(volumeId)}/snapshots`),
				),
		};
	});

export class FlyBoardApi extends Context.Service<FlyBoardApi, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/FlyBoardApi",
) {}
export const flyBoardApiLayer = (settings: FlyApiSettings) => Layer.effect(FlyBoardApi, make(settings));
