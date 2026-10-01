import { Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { CloudflareApiError, type CloudflareSettings } from "./cloudflare-dns.ts";

// Destructive DNS capability is isolated from the provisioner, which can only list and create records.
const make = (settings: CloudflareSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		return {
			record: (id: string) =>
				Effect.scoped(
					HttpClient.withScope(client)
						.execute(
							HttpClientRequest.delete(
								new URL(
									`/client/v4/zones/${encodeURIComponent(settings.zoneId)}/dns_records/${encodeURIComponent(id)}`,
									settings.baseUrl ?? "https://api.cloudflare.com",
								).href,
							).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`)),
						)
						.pipe(
							Effect.mapError(
								() => new CloudflareApiError({ operation: "delete_record", reason: "transport", status: null }),
							),
							Effect.flatMap((response) =>
								response.status === 404 || (response.status >= 200 && response.status < 300)
									? response.arrayBuffer.pipe(
											Effect.asVoid,
											Effect.mapError(
												() =>
													new CloudflareApiError({
														operation: "delete_record",
														reason: "transport",
														status: response.status,
													}),
											),
										)
									: Effect.fail(
											new CloudflareApiError({
												operation: "delete_record",
												reason: "status",
												status: response.status,
											}),
										),
							),
							Effect.timeout("30 seconds"),
							Effect.catchTag("TimeoutError", () =>
								Effect.fail(new CloudflareApiError({ operation: "delete_record", reason: "transport", status: null })),
							),
						),
				),
		};
	});

export class CloudflareDeletionApi extends Context.Service<
	CloudflareDeletionApi,
	Effect.Success<ReturnType<typeof make>>
>()("comms/cloud/CloudflareDeletionApi") {}
export const cloudflareDeletionApiLayer = (settings: CloudflareSettings) =>
	Layer.effect(CloudflareDeletionApi, make(settings));
