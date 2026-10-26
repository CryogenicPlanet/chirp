import { Context, Data, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http";
import type { FlyApiSettings } from "./fly-board-api.ts";

export class SetupCodeIssue extends Data.TaggedError("SetupCodeIssue")<{
	readonly code: "setup_closed" | "setup_code_unavailable" | "setup_code_unsupported";
}> {}
/** A GitHub or Google identity the board links when its first passkey is created. */
export interface SetupIdentity {
	readonly subject: string;
	readonly label: string;
}
const unavailable = () => new SetupCodeIssue({ code: "setup_code_unavailable" });
const ExecResult = Schema.Struct({
	exit_code: Schema.Int,
	exit_signal: Schema.optionalKey(Schema.Int),
	stdout: Schema.String.check(Schema.isMaxLength(1024)),
	stderr: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
});
// Images that link identities always reply with `identities`, 0 included; older ones ignore the argument and omit it.
const decodePayload = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Union([
			Schema.Struct({
				code: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/)),
				expires_at: Schema.Int,
				identities: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
			}),
			Schema.Struct({ error: Schema.Literal("setup_closed") }),
		]),
	),
	{ onExcessProperty: "error" },
);
// Boot's public auth state; only `setup_required` is read, so fields boot adds later are ignored.
const decodeAuthState = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Struct({ setup_required: Schema.Boolean })),
);
const readBounded = (response: HttpClientResponse.HttpClientResponse, limit: number) =>
	response.stream.pipe(
		Stream.runFoldEffect(
			() => new Uint8Array(),
			(previous, chunk) => {
				if (previous.length + chunk.length > limit) return unavailable();
				const combined = new Uint8Array(previous.length + chunk.length);
				combined.set(previous);
				combined.set(chunk, previous.length);
				return Effect.succeed(combined);
			},
		),
		Effect.map((bytes) => new TextDecoder().decode(bytes)),
		Effect.mapError(unavailable),
	);

// Immutable image operator command, never a shell or an editable-board command.
// https://docs.machines.dev/openapi.json: command is argv; timeout is seconds.
const make = (settings: FlyApiSettings) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		// Board requests go to its public address; the Fly proxy starts a stopped Machine for them.
		const boardGet = <A>(
			hostname: string,
			path: string,
			read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, SetupCodeIssue>,
		) =>
			Effect.scoped(
				HttpClient.withScope(client)
					.execute(HttpClientRequest.get(`https://${hostname}${path}`))
					.pipe(
						Effect.mapError(unavailable),
						Effect.flatMap((response) => (response.status === 200 ? read(response) : unavailable())),
					),
			).pipe(
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
				Effect.timeout("12 seconds"),
				Effect.catchTag("TimeoutError", unavailable),
			);
		return {
			wake: (hostname: string) => boardGet(hostname, "/health", () => Effect.void),
			setupRequired: (hostname: string) =>
				boardGet(hostname, "/_boot/auth/state", (response) =>
					readBounded(response, 4096).pipe(
						Effect.flatMap((text) =>
							Effect.try({ try: () => decodeAuthState(text).setup_required, catch: unavailable }),
						),
					),
				),
			issue: (app: string, machine: string, identities: ReadonlyArray<SetupIdentity>) =>
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
								// One JSON argument, never parsed by a shell. Without identities the argv stays what every image accepts.
								command: [
									"/usr/local/bin/bun",
									"/opt/comms/packages/boot/dist/setup-code.js",
									...(identities.length ? [JSON.stringify({ identities })] : []),
								],
								timeout: 5,
							}),
							Effect.mapError(unavailable),
						);
						const response = yield* HttpClient.withScope(client).execute(request).pipe(Effect.mapError(unavailable));
						if (response.status !== 200) return yield* unavailable();
						const text = yield* readBounded(response, 16384);
						const result = yield* Effect.try({
							try: () => Schema.decodeUnknownSync(Schema.fromJsonString(ExecResult))(text),
							catch: unavailable,
						});
						if (
							result.exit_code === 127 ||
							(result.exit_code === 1 &&
								result.stdout.trim() === "" &&
								result.stderr?.trim() === 'error: Module not found "/opt/comms/packages/boot/dist/setup-code.js"')
						)
							return yield* new SetupCodeIssue({ code: "setup_code_unsupported" });
						// Any other failed exit, including boot's {"error":"invalid_request"} for a malformed offer, is never a code.
						if (result.exit_code !== 0 || (result.exit_signal !== undefined && result.exit_signal !== 0))
							return yield* unavailable();
						const payload = yield* Effect.try({ try: () => decodePayload(result.stdout), catch: unavailable });
						if ("error" in payload) return yield* new SetupCodeIssue({ code: "setup_closed" });
						const now = Date.now();
						if (payload.expires_at <= now || payload.expires_at > now + 960_000) return yield* unavailable();
						if (payload.identities !== undefined && payload.identities > identities.length) return yield* unavailable();
						return {
							code: payload.code,
							expires_at: new Date(payload.expires_at).toISOString(),
							// Undefined only from an older image, which cannot prefill /setup from the fragment.
							identities: payload.identities,
						};
					}),
				).pipe(Effect.timeout("8 seconds"), Effect.catchTag("TimeoutError", unavailable)),
		};
	});
export class FlySetupApi extends Context.Service<FlySetupApi, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/FlySetupApi",
) {}
export const flySetupApiLayer = (settings: FlyApiSettings) => Layer.effect(FlySetupApi, make(settings));
