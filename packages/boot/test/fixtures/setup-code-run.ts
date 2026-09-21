/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { layer as editLockLayer } from "../../src/edit-lock.ts";
import { setupCodeServer } from "../../src/setup-code-server.ts";
import { authenticator } from "./authenticator.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing test directory");
const run = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const sql = yield* SqlClient.SqlClient;
	yield* initializeBootSchema;
	const output: unknown[] = [];
	const capturedConsole: Console.Console = {
		...console,
		log: (...values) => {
			output.push(...values);
		},
	};
	const restart = (reopenSetup = false) =>
		Layer.build(
			layer({ rpId: "comms.test", expectedOrigin: "https://comms.test", reopenSetup }).pipe(
				Layer.provide(
					Layer.mergeAll(eventsLayer(Effect.void), editLockLayer.pipe(Layer.provide(eventsLayer(Effect.void)))),
				),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, capturedConsole),
		);
	const auth = yield* restart();
	const clock = yield* Clock.Clock;
	let now = Date.now();
	const testClock: Clock.Clock = {
		sleep: (duration) => clock.sleep(duration),
		monotonicTimeNanos: clock.monotonicTimeNanos,
		monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
		currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
		currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
		currentTimeMillis: Effect.sync(() => now),
		currentTimeMillisUnsafe: () => now,
	};
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result));
				assert.ok(typeof result.failure === "object" && result.failure !== null && "code" in result.failure);
				assert.equal(result.failure.code, code);
			}),
		);
	const device = authenticator();
	yield* Effect.gen(function* () {
		const logged = output.length;
		const first = yield* auth.mintSetupCode;
		assert.match(first.code, /^[A-F0-9]{16}$/);
		assert.equal(first.expires_at, now + 900_000);
		const pending = yield* auth.startSetup(first.code);
		const second = yield* auth.mintSetupCode;
		assert.notEqual(first.code, second.code);
		yield* fails(auth.startSetup(first.code), "setup_code_invalid");
		yield* fails(auth.finishSetup(pending.id, device.registration(pending.options.challenge)), "challenge_invalid");
		now += 899_999;
		const finalMoment = yield* auth.startSetup(second.code);
		assert.deepEqual(yield* sql`SELECT expires_at FROM auth_challenges WHERE id=${finalMoment.id}`, [
			{ expires_at: second.expires_at },
		]);
		now += 1;
		assert.equal(yield* auth.setupOpen, true);
		assert.equal(output.length, logged + 1, "An expired operator code must restore a usable startup code");
		const replacement = output.at(-1);
		assert.ok(typeof replacement === "string");
		const replacementCode = /code ([A-F0-9]{16})$/.exec(replacement)?.[1];
		assert.ok(replacementCode);
		yield* fails(auth.startSetup(second.code), "setup_code_invalid");
		yield* auth.startSetup(replacementCode);
		yield* fails(
			auth.finishSetup(finalMoment.id, device.registration(finalMoment.options.challenge)),
			"challenge_invalid",
		);
		const loggedAfterExpiry = output.length;
		const crossing = yield* auth.mintSetupCode;
		now = crossing.expires_at - 4;
		const crossingChallenge = yield* auth.startSetup(crossing.code);
		now = crossing.expires_at - 3;
		let finishClockReads = 0;
		yield* fails(
			auth.finishSetup(crossingChallenge.id, device.registration(crossingChallenge.options.challenge)).pipe(
				Effect.provideService(Clock.Clock, {
					...testClock,
					currentTimeMillis: Effect.sync(() => {
						finishClockReads++;
						return ++now;
					}),
				}),
			),
			"challenge_invalid",
		);
		assert.equal(finishClockReads, 3, "Expiry is rechecked after asynchronous credential verification");
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 0);
		const third = yield* auth.mintSetupCode;
		for (let i = 0; i < 3; i++) yield* fails(auth.startSetup("wrong"), "setup_code_invalid");
		yield* fails(auth.startSetup(third.code), "setup_code_invalid");
		assert.equal(output.length, loggedAfterExpiry, "Unexpired operator-code rotation must stay private");
		const fresh = yield* auth.mintSetupCode;
		const ceremony = yield* auth.startSetup(fresh.code);
		yield* auth.finishSetup(ceremony.id, device.registration(ceremony.options.challenge));
		yield* fails(auth.mintSetupCode, "setup_closed");
		const recovery = yield* restart(true);
		yield* fails(recovery.mintSetupCode, "setup_closed");
	}).pipe(Effect.provideService(Clock.Clock, testClock));

	// A real private listener and a separate bundled-command process share only the socket.
	const invoke = () =>
		Effect.tryPromise(() =>
			promisify(execFile)("bun", [new URL("../../src/setup-code.ts", import.meta.url).pathname], {
				env: { ...process.env, DATA_DIR: root },
				timeout: 15_000,
			}),
		);
	const socket = `${root}/.boot-operator/setup.sock`;
	yield* Effect.gen(function* () {
		yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth));
		assert.equal((yield* fs.stat(`${root}/.boot-operator`)).mode & 0o777, 0o700);
		assert.equal((yield* fs.stat(socket)).mode & 0o777, 0o600);
		assert.equal((yield* invoke()).stdout.trim(), '{"error":"setup_closed"}');
		yield* sql`DELETE FROM passkeys`;
		const result = yield* invoke();
		assert.equal(result.stderr, "");
		const generated = yield* Schema.decodeEffect(
			Schema.fromJsonString(Schema.Struct({ code: Schema.String, expires_at: Schema.Number })),
		)(result.stdout);
		assert.match(generated.code, /^[A-F0-9]{16}$/);
		assert.ok(generated.expires_at > Date.now() + 890_000);
		const ceremony = yield* auth.startSetup(generated.code);
		yield* auth.finishSetup(ceremony.id, device.registration(ceremony.options.challenge));
		const existing = yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth), Effect.exit);
		assert.equal(existing._tag, "Failure", "An active listener cannot be replaced");
		assert.equal((yield* invoke()).stdout.trim(), '{"error":"setup_closed"}');
	}).pipe(Effect.scoped);
	assert.equal(yield* fs.exists(socket), false);
	// A crashed process leaves a socket pathname; only refused connections may reclaim it.
	const crashed = yield* Effect.tryPromise(() =>
		promisify(execFile)("bun", [
			"-e",
			'Bun.serve({unix:process.argv[1],fetch:()=>new Response("unused")});process.kill(process.pid,"SIGKILL")',
			socket,
		]),
	).pipe(Effect.result);
	assert.ok(Result.isFailure(crashed));
	assert.equal(yield* fs.exists(socket), true);
	yield* Effect.gen(function* () {
		yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth));
		assert.equal((yield* invoke()).stdout.trim(), '{"error":"setup_closed"}');
	}).pipe(Effect.scoped);
	assert.equal(yield* fs.exists(socket), false);
	// Symlinks and special files never become a listener or get unlinked.
	yield* fs.writeFileString(`${root}/keep`, "keep");
	yield* fs.symlink(`${root}/keep`, socket);
	const linked = yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth), Effect.scoped, Effect.exit);
	assert.equal(linked._tag, "Failure");
	assert.equal(yield* fs.readFileString(`${root}/keep`), "keep");
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: `${root}/boot.db` }), BunServices.layer)),
	),
);
console.log("setup code scenario passed");
