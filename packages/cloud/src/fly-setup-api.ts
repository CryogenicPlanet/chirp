import { Context, Data, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/unstable/http";
import type { FlyApiSettings } from "./fly-board-api.ts";

export class SetupCodeIssue extends Data.TaggedError("SetupCodeIssue")<{
	readonly code: "setup_closed" | "setup_code_unavailable" | "setup_code_unsupported";
}> {}
const unavailable = () => new SetupCodeIssue({ code: "setup_code_unavailable" });
const ExecResult = Schema.Struct({
	exit_code: Schema.Int,
	exit_signal: Schema.optionalKey(Schema.Int),
	stdout: Schema.String.check(Schema.isMaxLength(1024)),
	stderr: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
const decodePayload = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Union([
			Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/)), expires_at: Schema.Int }),
			Schema.Struct({ error: Schema.Literal("setup_closed") }),
		]),
	),
	{ onExcessProperty: "error" },
);

// Immutable image operator command, never a shell or an editable-board command.
// https://docs.machines.dev/openapi.json: command is argv; timeout is seconds.
const make = (settings: FlyApiSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		return {
			wake: (hostname: string) =>
				Effect.scoped(
					HttpClient.withScope(client)
						.execute(HttpClientRequest.get(`https://${hostname}/health`))
						.pipe(
							Effect.flatMap((response) => (response.status === 200 ? Effect.void : unavailable())),
							Effect.mapError(unavailable),
						),
				).pipe(
					Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
					Effect.timeout("12 seconds"),
					Effect.catchTag("TimeoutError", unavailable),
				),
			issue: (app: string, machine: string) =>
				Effect.scoped(
					Effect.gen(function* () {
						const request = yield* HttpClientRequest.post(
							new URL(
								`/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machine)}/exec`,
								settings.baseUrl ?? "https://api.machines.dev",
							).href,
						).pipe(
							HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(settings.token)}`),
							HttpClientRequest.bodyJson({
								command: ["/usr/local/bin/bun", "/opt/comms/packages/boot/dist/setup-code.js"],
								timeout: 5,
							}),
							Effect.mapError(unavailable),
						);
						const response = yield* HttpClient.withScope(client).execute(request).pipe(Effect.mapError(unavailable));
						if (response.status !== 200) return yield* unavailable();
						const bytes = yield* response.stream.pipe(
							Stream.runFoldEffect(
								() => new Uint8Array(),
								(previous, chunk) => {
									if (previous.length + chunk.length > 16384) return unavailable();
									const combined = new Uint8Array(previous.length + chunk.length);
									combined.set(previous);
									combined.set(chunk, previous.length);
									return Effect.succeed(combined);
								},
							),
							Effect.mapError(unavailable),
						);
						const result = yield* Effect.try({
							try: () => Schema.decodeUnknownSync(Schema.fromJsonString(ExecResult))(new TextDecoder().decode(bytes)),
							catch: unavailable,
						});
						if (
							result.exit_code === 127 ||
							(result.exit_code === 1 &&
								result.stdout.trim() === "" &&
								result.stderr?.trim() === 'error: Module not found "/opt/comms/packages/boot/dist/setup-code.js"')
						)
							return yield* new SetupCodeIssue({ code: "setup_code_unsupported" });
						if (result.exit_code !== 0 || (result.exit_signal !== undefined && result.exit_signal !== 0))
							return yield* unavailable();
						const payload = yield* Effect.try({ try: () => decodePayload(result.stdout), catch: unavailable });
						if ("error" in payload) return yield* new SetupCodeIssue({ code: "setup_closed" });
						const now = Date.now();
						if (payload.expires_at <= now || payload.expires_at > now + 960_000) return yield* unavailable();
						return { code: payload.code, expires_at: new Date(payload.expires_at).toISOString() };
					}),
				).pipe(Effect.timeout("8 seconds"), Effect.catchTag("TimeoutError", unavailable)),
		};
	});
export class FlySetupApi extends Context.Service<FlySetupApi, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/FlySetupApi",
) {}
export const flySetupApiLayer = (settings: FlyApiSettings) => Layer.effect(FlySetupApi, make(settings));
