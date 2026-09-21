import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Path, Schema } from "effect";

const reply = Schema.Union([
	Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[A-F0-9]{16}$/)), expires_at: Schema.Int }),
	Schema.Struct({ error: Schema.Literals(["setup_closed", "setup_code_unavailable"]) }),
]);

/** Fixed operator command. No code or database credential is read from the editable application. */
const command = Effect.gen(function* () {
	const path = yield* Path.Path;
	const dataDirectory = yield* Config.String("DATA_DIR").pipe(Config.withDefault("/data"));
	// Bun's fetch unix option has no Effect HttpClient counterpart.
	const response = yield* Effect.tryPromise(() =>
		fetch("http://localhost/setup-code", {
			method: "POST",
			unix: path.resolve(dataDirectory, ".boot-operator/setup.sock"),
			signal: AbortSignal.timeout(10_000),
		}),
	);
	const value = yield* Schema.decodeUnknownEffect(reply)(yield* Effect.tryPromise(() => response.json()));
	if ("error" in value && value.error === "setup_code_unavailable") process.exitCode = 1;
	yield* Console.log(JSON.stringify(value));
});
command.pipe(
	Effect.catchCause(() =>
		Effect.gen(function* () {
			process.exitCode = 1;
			yield* Console.log(JSON.stringify({ error: "setup_code_unavailable" }));
		}),
	),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
