/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- offers are written as raw JSON, malformed ones included */
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
import { LinkedIdentity } from "../../src/oidc-schema.ts";
import { setupCodeServer } from "../../src/setup-code-server.ts";
import { authenticator } from "./authenticator.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing test directory");
const issuer = "https://auth.chirp.wiki";
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
	// The issuer is only named: offered identities are linked under it, and nothing here talks to it.
	const restart = (reopenSetup = false) =>
		Layer.build(
			layer({ rpId: "comms.test", expectedOrigin: "https://comms.test", reopenSetup, oidc: { issuer } }).pipe(
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
		const first = yield* auth.mintSetupCode();
		assert.match(first.code, /^[A-F0-9]{16}$/);
		assert.equal(first.expires_at, now + 900_000);
		assert.equal(first.identities, 0);
		const pending = yield* auth.startSetup(first.code);
		assert.deepEqual(pending.identities, []);
		const second = yield* auth.mintSetupCode();
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
		const replacementCeremony = yield* auth.startSetup(replacementCode);
		yield* fails(
			auth.finishSetup(finalMoment.id, device.registration(finalMoment.options.challenge)),
			"challenge_invalid",
		);
		yield* auth.finishSetup(replacementCeremony.id, device.registration(replacementCeremony.options.challenge));
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		yield* sql`DELETE FROM passkeys`;
		const loggedAfterExpiry = output.length;
		const crossing = yield* auth.mintSetupCode();
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
		const third = yield* auth.mintSetupCode();
		for (let i = 0; i < 3; i++) yield* fails(auth.startSetup("wrong"), "setup_code_invalid");
		yield* fails(auth.startSetup(third.code), "setup_code_invalid");
		assert.equal(output.length, loggedAfterExpiry, "Unexpired operator-code rotation must stay private");
		const fresh = yield* auth.mintSetupCode();
		const ceremony = yield* auth.startSetup(fresh.code);
		yield* auth.finishSetup(ceremony.id, device.registration(ceremony.options.challenge));
		yield* fails(auth.mintSetupCode(), "setup_closed");
		const recovery = yield* restart(true);
		yield* fails(recovery.mintSetupCode(), "setup_closed");
	}).pipe(Effect.provideService(Clock.Clock, testClock));

	// A real private listener and a separate bundled-command process share only the socket. The offer is one argv
	// element, as Fly exec passes it; no shell is involved.
	const invoke = (...args: ReadonlyArray<string>) =>
		Effect.callback<{ readonly stdout: string; readonly stderr: string; readonly status: number }>((resume) => {
			execFile(
				"bun",
				[new URL("../../src/setup-code.ts", import.meta.url).pathname, ...args],
				{ env: { ...process.env, DATA_DIR: root }, timeout: 15_000 },
				(error, stdout, stderr) =>
					resume(
						Effect.succeed({
							stdout: stdout.trim(),
							stderr,
							status: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
						}),
					),
			);
		});
	const socket = `${root}/.boot-operator/setup.sock`;
	const offer = (identities: ReadonlyArray<{ readonly subject: string; readonly label: string }>) =>
		JSON.stringify({ identities });
	const rahul = { subject: "github:583231", label: "Rahul" };
	const google = { subject: "google:108", label: "rahul@example.com" };
	// Exactly these keys: Cloud tells a new image from an old one by whether `identities` is present.
	const minted = (stdout: string) =>
		Schema.decodeEffect(
			Schema.fromJsonString(Schema.Struct({ code: Schema.String, expires_at: Schema.Int, identities: Schema.Int })),
		)(stdout, { onExcessProperty: "error" });
	const linkedRows = sql`SELECT ${sql("key")}, value FROM settings WHERE ${sql("key")} LIKE 'auth.identity:%' ORDER BY value`;
	/** Straight to the socket, past the command's own checks. */
	const raw = (body: string) =>
		Effect.promise(() =>
			fetch("http://localhost/setup-code", { method: "POST", unix: socket, body }).then(async (response) => ({
				status: response.status,
				body: await response.text(),
			})),
		);
	yield* Effect.gen(function* () {
		yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth));
		assert.equal((yield* fs.stat(`${root}/.boot-operator`)).mode & 0o777, 0o700);
		assert.equal((yield* fs.stat(socket)).mode & 0o777, 0o600);
		assert.deepEqual(yield* invoke(), { stdout: '{"error":"setup_closed"}', stderr: "", status: 0 });
		// Once a passkey exists an offer is refused the same way and links nothing.
		assert.deepEqual(yield* invoke(offer([rahul])), { stdout: '{"error":"setup_closed"}', stderr: "", status: 0 });
		assert.equal((yield* linkedRows).length, 0);
		yield* sql`DELETE FROM passkeys`;
		// No argument: a plain code, as before, offering nothing.
		const result = yield* invoke();
		assert.equal(result.stderr, "");
		assert.equal(result.status, 0);
		const generated = yield* minted(result.stdout);
		assert.match(generated.code, /^[A-F0-9]{16}$/);
		assert.ok(generated.expires_at > Date.now() + 890_000);
		assert.equal(generated.identities, 0);
		assert.deepEqual((yield* auth.startSetup(generated.code)).identities, []);
		// An offer replaces that code and is listed for the setup page.
		const offered = yield* invoke(offer([rahul, google]));
		assert.equal(offered.status, 0);
		assert.equal(offered.stderr, "");
		const code = yield* minted(offered.stdout);
		assert.equal(code.identities, 2);
		assert.notEqual(code.code, generated.code);
		const shown = [
			{ provider: "github", label: "Rahul" },
			{ provider: "google", label: "rahul@example.com" },
		];
		assert.deepEqual((yield* auth.startSetup(code.code)).identities, shown);
		// Malformed offers are refused before boot touches the code, so the offered code and its offer still stand.
		for (const bad of [
			offer([{ subject: "github:0123", label: "leading zero" }]),
			offer([{ subject: "github:123456789012345678901", label: "too long" }]),
			offer([{ subject: "gitlab:1", label: "other provider" }]),
			offer([{ subject: "google:a b", label: "space" }]),
			offer([{ subject: "github:1", label: "" }]),
			offer([{ subject: "github:1", label: "x".repeat(101) }]),
			offer([{ subject: "github:1", label: "line\nbreak" }]),
			offer([{ subject: "github:1", label: "bidi \u202Eoverride" }]),
			offer([rahul, google, { subject: "github:2", label: "third" }]),
			offer([rahul, { ...rahul, label: "twin" }]),
			JSON.stringify({ identities: [rahul], issuer: "https://evil.test" }),
			JSON.stringify({ identities: [{ ...rahul, provider: "google" }] }),
			JSON.stringify({ identities: [rahul] }) + " ".repeat(2048),
			JSON.stringify({}),
			"not json",
			"",
		]) {
			const refused = yield* invoke(bad);
			assert.deepEqual([refused.stdout, refused.status], ['{"error":"invalid_request"}', 1], bad.slice(0, 80));
		}
		assert.deepEqual((yield* invoke(offer([rahul]), offer([google]))).stdout, '{"error":"invalid_request"}');
		// The listener refuses on its own as well, whatever reaches the socket.
		for (const bad of [
			"not json",
			offer([rahul, rahul]),
			offer([{ subject: "github:1", label: "\u0000" }]),
			JSON.stringify({ identities: [rahul] }) + " ".repeat(5000),
		]) {
			const refused = yield* raw(bad);
			assert.ok(refused.status === 400 || refused.status === 413, `${refused.status} ${bad.slice(0, 80)}`);
			assert.ok(!refused.body.includes("code"));
		}
		assert.deepEqual(yield* raw(offer([rahul, rahul])), { status: 400, body: '{"error":"invalid_request"}' });
		const still = yield* auth.startSetup(code.code);
		assert.deepEqual(still.identities, shown);
		assert.equal((yield* linkedRows).length, 0, "An offer is not a link before the passkey");
		// Finishing links both under boot's configured issuer, in the passkey's commit, and signs the human in.
		const session = yield* auth.finishSetup(still.id, device.registration(still.options.challenge));
		assert.ok((yield* auth.authenticateSession(session.token)).id);
		const rows = yield* linkedRows;
		assert.equal(rows.length, 2);
		const linked = yield* Effect.forEach(rows, (row) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(LinkedIdentity))(row.value),
		);
		assert.deepEqual(
			linked.map(({ created_at: _created, ...identity }) => identity),
			[
				{ issuer, subject: rahul.subject, provider: "github", label: "Rahul", last_used_at: null },
				{ issuer, subject: google.subject, provider: "google", label: google.label, last_used_at: null },
			],
		);
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		const existing = yield* setupCodeServer(root).pipe(Effect.provideService(Auth, auth), Effect.exit);
		assert.equal(existing._tag, "Failure", "An active listener cannot be replaced");
		assert.equal((yield* invoke()).stdout, '{"error":"setup_closed"}');
		assert.equal((yield* invoke(offer([{ subject: "github:9", label: "late" }]))).stdout, '{"error":"setup_closed"}');
		assert.equal((yield* linkedRows).length, 2);
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
