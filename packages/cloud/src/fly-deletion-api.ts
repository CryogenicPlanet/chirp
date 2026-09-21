import { Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { FlyApiError, type FlyApiSettings } from "./fly-board-api.ts";

// Isolated from the provisioner's provider service: only deletion workers receive this capability.
// Contract: https://docs.machines.dev/openapi.json (DELETE app: 202, machine/volume: 200).
const make = (settings: FlyApiSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const remove = (operation: string, path: string) =>
			Effect.scoped(
				HttpClient.withScope(client)
					.execute(
						HttpClientRequest.make("DELETE")(new URL(path, settings.baseUrl ?? "https://api.machines.dev").href).pipe(
							HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`),
						),
					)
					.pipe(
						Effect.mapError(() => new FlyApiError({ operation, reason: "transport", status: null })),
						Effect.flatMap((response) =>
							response.status === 404 || (response.status >= 200 && response.status < 300)
								? response.arrayBuffer.pipe(
										Effect.asVoid,
										Effect.mapError(() => new FlyApiError({ operation, reason: "transport", status: response.status })),
									)
								: Effect.fail(new FlyApiError({ operation, reason: "status", status: response.status })),
						),
						Effect.timeout("75 seconds"),
						Effect.catchTag("TimeoutError", () =>
							Effect.fail(new FlyApiError({ operation, reason: "transport", status: null })),
						),
					),
			);
		const segment = encodeURIComponent;
		return {
			app: (name: string) => remove("delete_app", `/v1/apps/${segment(name)}`),
			machine: (app: string, id: string) =>
				remove("delete_machine", `/v1/apps/${segment(app)}/machines/${segment(id)}?force=true`),
			volume: (app: string, id: string) => remove("delete_volume", `/v1/apps/${segment(app)}/volumes/${segment(id)}`),
		};
	});
export class FlyDeletionApi extends Context.Service<FlyDeletionApi, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/FlyDeletionApi",
) {}
export const flyDeletionApiLayer = (settings: FlyApiSettings) => Layer.effect(FlyDeletionApi, make(settings));
