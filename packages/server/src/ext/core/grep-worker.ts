import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Schema, Stdio, Stream } from "effect";
import { GrepJob, GrepScan, scan } from "./grep-scan.ts";

// One scan per process, so grep.ts can SIGKILL a pattern that backtracks without end.
const run = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const encoded = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
	const job = yield* Schema.decodeEffect(Schema.fromJsonString(GrepJob))(encoded);
	yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(GrepScan))(scan(job)));
});
run.pipe(
	Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
