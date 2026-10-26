import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Path, Schema } from "effect";
import { SetupOffer } from "./oidc-schema.ts";

const reply = Schema.Union([
	Schema.Struct({
		code: Schema.String.check(Schema.isPattern(/^[A-F0-9]{16}$/)),
		expires_at: Schema.Int,
		identities: Schema.Int,
	}),
	Schema.Struct({ error: Schema.Literals(["setup_closed", "setup_code_unavailable", "invalid_request"]) }),
]);

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {}) {}

/** At most one argument: the JSON identity offer, as one argv element. Nothing here reaches a shell. */
const offer = Effect.gen(function* () {
	const values = process.argv.slice(2);
	const value = values[0];
	if (value === undefined) return undefined;
	if (values.length > 1 || Buffer.byteLength(value) > 2048) return yield* new InvalidRequest();
	yield* Schema.decodeEffect(Schema.fromJsonString(SetupOffer))(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError(() => new InvalidRequest()),
	);
	return value;
});

/** Fixed operator command. No code or database credential is read from the editable application. */
const command = Effect.gen(function* () {
	const path = yield* Path.Path;
	const body = yield* offer;
	const dataDirectory = yield* Config.String("DATA_DIR").pipe(Config.withDefault("/data"));
	// Bun's fetch unix option has no Effect HttpClient counterpart.
	const response = yield* Effect.tryPromise(() =>
		fetch("http://localhost/setup-code", {
			method: "POST",
			unix: path.resolve(dataDirectory, ".boot-operator/setup.sock"),
			signal: AbortSignal.timeout(10_000),
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
		}),
	);
	const value = yield* Schema.decodeUnknownEffect(reply)(yield* Effect.tryPromise(() => response.json()));
	if ("error" in value && value.error !== "setup_closed") process.exitCode = 1;
	yield* Console.log(JSON.stringify(value));
});
command.pipe(
	Effect.catchTag("InvalidRequest", () =>
		Effect.gen(function* () {
			process.exitCode = 1;
			yield* Console.log(JSON.stringify({ error: "invalid_request" }));
		}),
	),
	Effect.catchCause(() =>
		Effect.gen(function* () {
			process.exitCode = 1;
			yield* Console.log(JSON.stringify({ error: "setup_code_unavailable" }));
		}),
	),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
