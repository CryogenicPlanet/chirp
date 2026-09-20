import { Config, Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export interface CloudflareSettings {
	readonly token: Redacted.Redacted;
	readonly zoneId: string;
	readonly baseUrl?: string;
}

export class CloudflareApiError extends Data.TaggedError("CloudflareApiError")<{
	readonly operation: string;
	readonly reason: "transport" | "status" | "decode";
	readonly status: number | null;
}> {}

export const cloudflareSettings = Config.all({
	token: Config.Redacted("CLOUDFLARE_API_TOKEN"),
	zoneId: Config.String("CLOUDFLARE_ZONE_ID"),
}).pipe(
	Effect.filterOrFail(
		(settings) => /^[a-f0-9]{32}$/.test(settings.zoneId),
		() => new CloudflareApiError({ operation: "configure_zone", reason: "decode", status: null }),
	),
);

const DnsRecord = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	type: Schema.String,
	content: Schema.String,
	proxied: Schema.optionalKey(Schema.Boolean),
});
export type DnsRecord = typeof DnsRecord.Type;
const envelope = <A extends Schema.Top>(result: A) => Schema.Struct({ success: Schema.Literal(true), result });
const RecordList = Schema.Struct({
	success: Schema.Literal(true),
	result: Schema.Array(DnsRecord),
	result_info: Schema.Struct({ total_count: Schema.Int }),
});

const make = (settings: CloudflareSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const root = `/client/v4/zones/${encodeURIComponent(settings.zoneId)}`;
		const request = (method: "GET" | "POST", path: string) =>
			HttpClientRequest.make(method)(
				new URL(`${root}${path}`, settings.baseUrl ?? "https://api.cloudflare.com").href,
			).pipe(
				HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`),
				HttpClientRequest.setHeader("accept", "application/json"),
			);
		const json = <A, I>(operation: string, schema: Schema.Codec<A, I>, outgoing: HttpClientRequest.HttpClientRequest) =>
			Effect.scoped(
				HttpClient.withScope(client)
					.execute(outgoing)
					.pipe(
						Effect.flatMap((response) =>
							response.status >= 200 && response.status < 300
								? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
										Effect.mapError(
											() => new CloudflareApiError({ operation, reason: "decode", status: response.status }),
										),
									)
								: Effect.fail(new CloudflareApiError({ operation, reason: "status", status: response.status })),
						),
						Effect.timeout("30 seconds"),
						Effect.catchTags({
							HttpClientError: () =>
								Effect.fail(new CloudflareApiError({ operation, reason: "transport", status: null })),
							TimeoutError: () => Effect.fail(new CloudflareApiError({ operation, reason: "transport", status: null })),
						}),
					),
			);
		return {
			getZone: json(
				"get_zone",
				envelope(Schema.Struct({ name: Schema.String, status: Schema.String, type: Schema.String })),
				request("GET", ""),
			).pipe(Effect.map((value) => value.result)),
			listRecords: (name: string) => {
				const query = new URLSearchParams({ "name.exact": name, per_page: "100" });
				return json("list_records", RecordList, request("GET", `/dns_records?${query}`)).pipe(
					Effect.flatMap((value) =>
						value.result.length === value.result_info.total_count
							? Effect.succeed(value.result)
							: Effect.fail(new CloudflareApiError({ operation: "list_records", reason: "decode", status: 200 })),
					),
				);
			},
			createRecord: (name: string, type: "A" | "TXT", content: string) =>
				HttpClientRequest.bodyJson(request("POST", "/dns_records"), {
					name,
					type,
					content,
					ttl: 60,
					proxied: false,
				}).pipe(
					Effect.mapError(() => new CloudflareApiError({ operation: "create_record", reason: "decode", status: null })),
					Effect.flatMap((outgoing) => json("create_record", envelope(DnsRecord), outgoing)),
					Effect.asVoid,
				),
		};
	});

export class CloudflareDns extends Context.Service<CloudflareDns, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/CloudflareDns",
) {}
export const cloudflareDnsLayer = (settings: CloudflareSettings) => Layer.effect(CloudflareDns, make(settings));
