import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { FlyApiSettings } from "./fly-board-api.ts";

export class FlySecretsError extends Data.TaggedError("FlySecretsError")<{
	readonly reason: "transport" | "status" | "decode" | "verification";
	readonly status: number | null;
}> {}

const Metadata = Schema.Struct({ name: Schema.NonEmptyString, digest: Schema.NonEmptyString });
const Listing = Schema.Struct({ secrets: Schema.Array(Metadata) });
const Updated = Schema.Struct({ ...Listing.fields, version: Schema.Int });

const make = (settings: FlyApiSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const request = (method: "GET" | "POST", path: string) =>
			HttpClientRequest.make(method)(new URL(path, settings.baseUrl ?? "https://api.machines.dev").href).pipe(
				HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`),
				HttpClientRequest.setHeader("accept", "application/json"),
			);
		const send = <A, I>(outgoing: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>) =>
			Effect.scoped(
				HttpClient.withScope(client)
					.execute(outgoing)
					.pipe(
						Effect.mapError(() => new FlySecretsError({ reason: "transport", status: null })),
						Effect.flatMap((response) =>
							response.status >= 200 && response.status < 300
								? HttpClientResponse.schemaBodyJson(schema)(response).pipe(
										Effect.mapError(() => new FlySecretsError({ reason: "decode", status: response.status })),
									)
								: Effect.fail(new FlySecretsError({ reason: "status", status: response.status })),
						),
						Effect.timeout("75 seconds"),
						Effect.catchTag("TimeoutError", () =>
							Effect.fail(new FlySecretsError({ reason: "transport", status: null })),
						),
					),
			);
		return {
			// Upserting the same values can safely repeat before the first Machine exists.
			// Metadata continuity proves provider observation, not independent value correctness.
			ensure: (appName: string, secrets: Redacted.Redacted<Record<string, string>>) =>
				Effect.gen(function* () {
					const values = Redacted.value(secrets);
					const names = Object.keys(values);
					if (names.length === 0) return yield* new FlySecretsError({ reason: "verification", status: null });
					const path = `/v1/apps/${encodeURIComponent(appName)}/secrets`;
					const outgoing = yield* HttpClientRequest.bodyJson(request("POST", path), { values }).pipe(
						Effect.mapError(() => new FlySecretsError({ reason: "decode", status: null })),
					);
					const updated = yield* send(outgoing, Updated);
					if (
						updated.version < 0 ||
						names.some((name) => updated.secrets.filter((secret) => secret.name === name).length !== 1)
					) {
						return yield* new FlySecretsError({ reason: "verification", status: null });
					}
					const query = new URLSearchParams({ min_version: String(updated.version), show_secrets: "false" });
					const observed = yield* send(request("GET", `${path}?${query.toString()}`), Listing);
					for (const name of names) {
						const expected = updated.secrets.find((secret) => secret.name === name);
						const matches = observed.secrets.filter((secret) => secret.name === name);
						if (matches.length !== 1 || matches[0]?.digest !== expected?.digest) {
							return yield* new FlySecretsError({ reason: "verification", status: null });
						}
					}
					return updated.version;
				}),
		};
	});

export class FlySecrets extends Context.Service<FlySecrets, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/FlySecrets",
) {}
export const flySecretsLayer = (settings: FlyApiSettings) => Layer.effect(FlySecrets, make(settings));
