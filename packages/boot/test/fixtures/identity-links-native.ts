import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { advisoryClientLayer } from "@comms/storage/remote-client";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Console, Context, Effect, FileSystem, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer as authLayer } from "../../src/auth.ts";
import { appendedAuthColumns, authTables } from "../../src/boot-auth-tables.ts";
import { eventTables } from "../../src/boot-event-tables.ts";
import { runtimeTables } from "../../src/boot-runtime-tables.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { sourceTables } from "../../src/boot-source-tables.ts";
import { layer as lockLayer } from "../../src/edit-lock.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import { authenticator } from "./authenticator.ts";
import { identityId } from "../../src/oidc-schema.ts";
import { fakeIssuer, type Grant } from "./oidc-issuer.ts";

const Settings = Schema.Struct({
	host: Schema.String,
	port: Schema.Int,
	database: Schema.String,
	username: Schema.String,
	password: Schema.String,
});
const primary = { rpId: "comms.test", expectedOrigin: "https://comms.test" };
const octocat: Grant = { subject: "github:1", provider: "github", label: "octocat" };
const human: Grant = { subject: "google:108", provider: "google", label: "human@example.com" };
const issuer = await fakeIssuer();

const main = Effect.gen(function* () {
	const [engine, directory] = process.argv.slice(2);
	const layer =
		engine === "sqlite"
			? SqliteClient.layer({ filename: ":memory:" })
			: yield* Effect.gen(function* () {
					if (!directory || (engine !== "pg" && engine !== "mysql"))
						return yield* Effect.die("Missing native configuration");
					const settings = yield* (yield* FileSystem.FileSystem)
						.readFileString(`${directory}/${engine}-initialize-boot.json`)
						.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))));
					if (settings.database !== "comms_initialize_boot") return yield* Effect.die("Refusing non-disposable store");
					return advisoryClientLayer({
						connection: { ...settings, password: Redacted.make(settings.password), engine, tls: false },
					});
				});
	yield* Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Boot's own table definitions, as temporary tables on the one pinned session.
		if (engine === "pg" || engine === "mysql") {
			const finals = appendedAuthColumns(sql, engine).finals;
			for (const table of [
				...authTables(sql, engine).filter((table) => !finals.some((final) => final.name === table.name)),
				...finals,
				...eventTables(sql, engine),
				...runtimeTables(sql, engine),
				...sourceTables(sql, engine),
			]) {
				const [ddl, parameters] = table.run.compile();
				assert.equal(parameters.length, 0);
				// MySQL refuses foreign keys on temporary tables; only source history has them, and nothing here reads it.
				if (!ddl.includes("FOREIGN KEY")) yield* sql.unsafe(ddl.replace("CREATE TABLE", "CREATE TEMPORARY TABLE"));
			}
			yield* sql`INSERT INTO seq (singleton,${sql("next")},published_through) VALUES(1,1,0)`;
		} else yield* initializeBootSchema;
		const output: string[] = [];
		const captured: Console.Console = {
			...console,
			log: (...values: readonly unknown[]) => {
				for (const value of values) if (typeof value === "string") output.push(value);
			},
		};
		const build = Layer.build(
			authLayer({ ...primary, oidc: { issuer: issuer.issuer } }).pipe(
				Layer.provide(lockLayer.pipe(Layer.provideMerge(eventsLayer(Effect.void)))),
			),
		).pipe(
			Effect.map((context) => Context.get(context, Auth)),
			Effect.provideService(Console.Console, captured),
		);
		const auth = yield* build;
		const device = authenticator();
		const counter = { value: 0 };
		const proof = (started: { readonly id: string; readonly options: { readonly challenge: string } }) => ({
			id: started.id,
			response: device.assertion(started.options.challenge, ++counter.value),
		});
		const code = output.at(-1)?.split("code ")[1];
		assert.ok(code);
		const setup = yield* auth.startSetup(code);
		yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
		const login = yield* auth.startLogin;
		const owner = yield* auth.finishLogin(login.id, proof(login).response);
		const begin = (instance: typeof auth, grant: Grant, intent: "login" | "link" = "login") =>
			Effect.gen(function* () {
				const started = yield* instance.startOidc(
					{ intent, provider: grant.provider },
					primary,
					intent === "link" ? owner.id : null,
				);
				const issued = issuer.issue(started.authorizationUrl, grant);
				return { state: issued.state, code: issued.code, iss: issuer.issuer, binding: started.binding, refused: false };
			});
		const pendingId = (instance: typeof auth, grant: Grant) =>
			Effect.gen(function* () {
				const result = yield* instance.finishOidc(yield* begin(instance, grant, "link"));
				assert.equal(result._tag, "pending");
				const id = new URL(result.next, primary.expectedOrigin).searchParams.get("link");
				assert.ok(id);
				return id;
			});
		const sessions = Effect.map(sql`SELECT id FROM sessions`, (rows) => rows.length);
		// Link, then sign in and stamp the identity's last use.
		const github = yield* pendingId(auth, octocat);
		yield* auth.linkIdentity(
			{ id: github },
			proof(yield* auth.startIdentityLinkAssertion({ id: github }, owner.id)),
			owner.id,
		);
		const signedIn = yield* auth.finishOidc(yield* begin(auth, octocat));
		assert.equal(signedIn._tag, "session");
		const listed = yield* auth.listIdentities(owner.id);
		assert.equal(listed.identities.length, 1);
		assert.equal(typeof listed.identities[0]?.last_used_at, "number");
		// One state, two callbacks: exactly one session, even when the issuer would redeem the code twice.
		issuer.modes.reuse = true;
		const duplicated = yield* begin(auth, octocat);
		const before = yield* sessions;
		const callbacks = yield* Effect.all(
			[Effect.result(auth.finishOidc(duplicated)), Effect.result(auth.finishOidc(duplicated))],
			{
				concurrency: "unbounded",
			},
		);
		assert.equal(callbacks.filter(Result.isSuccess).length, 1);
		assert.equal(yield* sessions, before + 1);
		// Across two boot instances, which share no mutex, the database still gives the row to one.
		const other = yield* build;
		const across = yield* begin(auth, octocat);
		const beforeAcross = yield* sessions;
		const raced = yield* Effect.forEach([auth, other], (instance) => Effect.result(instance.finishOidc(across)), {
			concurrency: "unbounded",
		});
		issuer.modes.reuse = false;
		assert.equal(raced.filter(Result.isSuccess).length, 1);
		assert.equal(yield* sessions, beforeAcross + 1);
		// One pending link, two confirmations: one identity.
		const google = yield* pendingId(auth, human);
		const proofs = [
			proof(yield* auth.startIdentityLinkAssertion({ id: google }, owner.id)),
			proof(yield* auth.startIdentityLinkAssertion({ id: google }, owner.id)),
		];
		const confirmations = yield* Effect.forEach(
			proofs,
			(value) => Effect.result(auth.linkIdentity({ id: google }, value, owner.id)),
			{ concurrency: "unbounded" },
		);
		assert.equal(confirmations.filter(Result.isSuccess).length, 1);
		assert.deepEqual(yield* auth.linkedProviders, ["github", "google"]);
		// Unlinking ends every other session and the identity no longer signs in.
		const githubId = (yield* auth.listIdentities(owner.id)).identities.find((item) => item.provider === "github")?.id;
		assert.ok(githubId);
		yield* auth.unlinkIdentity(
			{ id: githubId },
			proof(yield* auth.startIdentityUnlinkAssertion({ id: githubId }, owner.id)),
			owner.id,
		);
		assert.equal(yield* sessions, 1);
		const refused = yield* Effect.result(auth.startOidc({ intent: "login", provider: "github" }, primary, null));
		assert.ok(Result.isFailure(refused) && "code" in refused.failure && refused.failure.code === "identity_not_linked");
		// A new process on the same store still signs the remaining identity in.
		const restarted = yield* build;
		assert.equal((yield* restarted.finishOidc(yield* begin(restarted, human)))._tag, "session");
		// An identity offered with a setup code is linked by the first passkey registration, in its commit, and only
		// under the code it came with: a later mint replaces it, even one racing the finish from another Auth instance.
		// Both share this fixture's one pinned connection, so this checks the outcome, not lockBootWrite's row lock.
		yield* sql`DELETE FROM passkeys`;
		yield* sql`DELETE FROM sessions`;
		const rahul = { subject: "github:583231", provider: "github", label: "Rahul" } as const;
		const offeredKey = `auth.identity:${yield* identityId(issuer.issuer, rahul.subject)}`;
		const offeredRow = sql`SELECT value FROM settings WHERE ${sql("key")}=${offeredKey}`;
		const stale = yield* restarted.mintSetupCode([rahul]);
		const staleChallenge = yield* restarted.startSetup(stale.code);
		const fresh = yield* restarted.mintSetupCode([{ ...rahul, label: "Rahul again" }]);
		assert.equal(fresh.identities, 1);
		const staleFinish = yield* Effect.result(
			restarted.finishSetup(staleChallenge.id, device.registration(staleChallenge.options.challenge)),
		);
		assert.ok(
			Result.isFailure(staleFinish) &&
				"code" in staleFinish.failure &&
				staleFinish.failure.code === "challenge_invalid",
		);
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 0);
		assert.equal((yield* offeredRow).length, 0);
		const challenge = yield* restarted.startSetup(fresh.code);
		const { finished, replaced } = yield* Effect.all(
			{
				finished: Effect.result(restarted.finishSetup(challenge.id, device.registration(challenge.options.challenge))),
				replaced: Effect.result(other.mintSetupCode([{ ...rahul, label: "Rahul raced" }])),
			},
			{ concurrency: "unbounded" },
		);
		const winner = Result.isSuccess(finished) ? "Rahul again" : "Rahul raced";
		if (Result.isFailure(finished)) {
			assert.ok(
				"code" in finished.failure && finished.failure.code === "challenge_invalid" && Result.isSuccess(replaced),
			);
			assert.equal((yield* sql`SELECT id FROM passkeys`).length, 0);
			assert.equal((yield* offeredRow).length, 0);
			const retried = yield* other.startSetup(replaced.success.code);
			yield* other.finishSetup(retried.id, device.registration(retried.options.challenge));
		} else assert.ok(Result.isFailure(replaced));
		assert.equal((yield* sql`SELECT id FROM passkeys`).length, 1);
		const stored = yield* offeredRow.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: Schema.String })))),
		);
		assert.equal(stored.length, 1);
		assert.ok(stored[0]?.value.includes(`"label":"${winner}"`) && stored[0]?.value.includes(issuer.issuer));
		assert.equal(
			(yield* other.finishOidc(yield* begin(other, { subject: rahul.subject, provider: "github", label: "rahul" })))
				._tag,
			"session",
		);
	}).pipe(Effect.provide(layer));
	return { engine, passed: true };
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)));

try {
	const result = await Effect.runPromise(main);
	await Effect.runPromise(Console.log(JSON.stringify(result)));
} finally {
	await issuer.close();
}
