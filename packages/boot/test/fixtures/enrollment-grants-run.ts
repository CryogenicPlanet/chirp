import { layer as durableEventsLayer } from "../../src/events.ts";
/* oxlint-disable effecttsgo/node-builtin-import */
import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Clock, Console, Context, Crypto, Effect, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Auth, layer } from "../../src/auth.ts";
import { initializeBootSchema } from "../../src/boot-schema.ts";
import { layer as eventsLayer } from "../../src/events.ts";
import type { EnrollmentDecision } from "../../src/enrollment-schema.ts";
import { EditLock, layer as rawEditLockLayer } from "../../src/edit-lock.ts";
import { authenticator } from "./authenticator.ts";

const editLockLayer = rawEditLockLayer.pipe(Layer.provideMerge(durableEventsLayer(Effect.void)));
const filename = process.argv[2],
	scenario = process.argv[3];
if (!filename) throw new Error("Missing database");
const code = (value: unknown) =>
	typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
		? value.code
		: undefined;
const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const crypto = yield* Crypto.Crypto;
	yield* initializeBootSchema;
	const output: string[] = [];
	const captured: Console.Console = {
		...console,
		log: (...values: readonly unknown[]) => {
			for (const value of values) if (typeof value === "string") output.push(value);
		},
	};
	const context = yield* Layer.build(
		layer({ rpId: "comms.test", expectedOrigin: "https://comms.test" }).pipe(
			Layer.provideMerge(Layer.mergeAll(eventsLayer(Effect.void), editLockLayer)),
		),
	).pipe(Effect.provideService(Console.Console, captured));
	const auth = Context.get(context, Auth);
	const lock = Context.get(context, EditLock);
	const fails = <A, E, R>(effect: Effect.Effect<A, E, R>, expected: string) =>
		effect.pipe(
			Effect.result,
			Effect.map((result) => {
				assert.ok(Result.isFailure(result), `expected ${expected}`);
				assert.equal(code(result.failure), expected);
			}),
		);
	const device = authenticator();
	let counter = 0;
	const setup = yield* auth.startSetup(output[0]?.split("code ")[1] ?? "");
	yield* auth.finishSetup(setup.id, device.registration(setup.options.challenge));
	const decide = (params: EnrollmentDecision, signed: EnrollmentDecision = params) =>
		Effect.gen(function* () {
			const challenge = yield* auth.startEnrollmentAssertion(signed);
			return yield* auth.decideEnrollment(params, {
				id: challenge.id,
				response: device.assertion(challenge.options.challenge, ++counter),
			});
		});
	const held = (scopes: ReadonlyArray<"read" | "write" | "fs"> = ["read", "write", "fs"], agent = "dot") =>
		auth.createHeldEnrollment({ extension: "mcp", agent, label: "chatgpt", scopes });
	const approve = (id: string, scopes: EnrollmentDecision["scopes"] = ["read", "write"]) =>
		decide({ id, decision: "approve", scopes, long_lived: false });
	const now = yield* Clock.currentTimeMillis;

	if (scenario === "lifecycle") {
		// A held kind is reachable only through boot's private channel.
		yield* fails(auth.createEnrollment({ name: "dot", kind: "extension:mcp", host: "chatgpt" }), "invalid_request");
		for (const input of [
			{ extension: "", agent: "dot", label: "chatgpt", scopes: ["read"] },
			{ extension: "mcp", agent: "rahul", label: "chatgpt", scopes: ["read"] },
			{ extension: "mcp", agent: "boot", label: "chatgpt", scopes: ["read"] },
			{ extension: "mcp", agent: "dot", label: "ChatGPT", scopes: ["read"] },
			{ extension: "mcp", agent: "dot", label: "chatgpt", scopes: ["write"] },
			{ extension: "mcp", agent: "dot", label: "chatgpt", scopes: ["read", "read"] },
			{ extension: "m:cp", agent: "dot", label: "chatgpt", scopes: ["read"] },
		] as const)
			yield* fails(auth.createHeldEnrollment(input), "invalid_request");
		const request = yield* held();
		const info = yield* auth.enrollmentInfo(request.id);
		assert.equal(info.held, "mcp");
		assert.equal(info.kind, "extension:mcp");
		assert.deepEqual(info.requested, ["read", "write", "fs"]);
		assert.deepEqual(yield* auth.collectHeldEnrollment(request.id, "mcp"), {
			status: "pending",
			expires_at: request.expires_at,
		});
		yield* fails(auth.collectHeldEnrollment(request.id, "other"), "enrollment_invalid");
		yield* fails(auth.collectHeldEnrollment(`e_${"a".repeat(43)}`, "mcp"), "enrollment_invalid");
		// The public collection route never yields a held row, whatever secret is offered.
		for (const secret of [Buffer.from(yield* crypto.randomBytes(32)).toString("base64url"), "a".repeat(43)])
			yield* fails(auth.collectEnrollment(request.id, secret), "device_secret_invalid");
		// The proof binds the exact scopes; the human may only narrow what the extension asked for.
		const signed: EnrollmentDecision = { id: request.id, decision: "approve", scopes: ["read"], long_lived: false };
		yield* fails(decide({ ...signed, scopes: ["read", "write"] }, signed), "challenge_invalid");
		yield* fails(decide({ ...signed, long_lived: true }), "invalid_request");
		const narrow = yield* held(["read"]);
		yield* fails(approve(narrow.id, ["read", "write"]), "invalid_request");
		yield* approve(request.id);
		// Concurrent collections agree on one family and write exactly one access row, with no secret field.
		const results = yield* Effect.all(
			Array.from({ length: 6 }, () => auth.collectHeldEnrollment(request.id, "mcp")),
			{ concurrency: "unbounded" },
		);
		const first = results[0];
		assert.ok(first?.status === "approved");
		for (const result of results) {
			assert.deepEqual(result, first);
			assert.deepEqual(Object.keys(result).sort(), ["agent", "expires_at", "family", "label", "scopes", "status"]);
		}
		assert.deepEqual(first.scopes, ["read", "write"]);
		assert.equal(first.agent, "dot");
		assert.equal(first.label, "chatgpt");
		assert.ok(Math.abs(first.expires_at - (now + 7_776_000_000)) < 60_000);
		assert.deepEqual(yield* sql`SELECT kind FROM tokens WHERE family=${first.family}`, [{ kind: "access" }]);
		assert.deepEqual(yield* sql`SELECT status FROM enrollments WHERE id=${request.id}`, [{ status: "collected" }]);
		yield* fails(auth.collectEnrollment(request.id, "a".repeat(43)), "device_secret_invalid");

		const identity = yield* auth.authenticateGrant(first.family, "mcp");
		assert.deepEqual(identity, {
			id: first.family,
			agent: "dot",
			kind: "agent",
			label: "chatgpt",
			scopes: ["read", "write"],
			expiresAt: first.expires_at,
			held: "mcp",
		});
		const stamped = yield* sql`SELECT last_used_at FROM tokens WHERE family=${first.family}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ last_used_at: Schema.Int })))),
		);
		assert.ok((stamped[0]?.last_used_at ?? 0) >= now);
		yield* fails(auth.authenticateGrant(first.family, "other"), "grant_invalid");
		yield* fails(auth.authenticateGrant("f_short", "mcp"), "grant_invalid");
		// The stored hash covers a discarded value: neither it nor anything the app saw is a bearer.
		const stored = yield* sql`SELECT hash FROM tokens WHERE family=${first.family}`.pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ hash: Schema.String })))),
		);
		for (const token of [stored[0]?.hash ?? "", first.family.slice(2), request.id.slice(2)])
			yield* fails(auth.authenticateAccess(token), "token_invalid");

		// A public enrollment's family and a minted family are not grants.
		const normal = yield* auth.createEnrollment({ name: "codex", kind: "codex", host: "laptop" });
		yield* decide({ id: normal.id, decision: "approve", scopes: ["read"], long_lived: false });
		const pair = yield* auth.collectEnrollment(normal.id, normal.device_secret);
		assert.ok(pair.status === "collected");
		yield* fails(auth.authenticateGrant(pair.family, "mcp"), "grant_invalid");
		yield* fails(auth.authenticateGrant(pair.family, "codex"), "grant_invalid");
		const minted = `f_${"m".repeat(43)}`;
		yield* sql`INSERT INTO tokens(id,pair_id,family,agent,kind,hash,label,scopes,expires_at,created_at)
		VALUES('t_minted','p_minted',${minted},'dot','access','minted-hash','chatgpt','["read"]',${now + 100_000},${now})`;
		yield* fails(auth.authenticateGrant(minted, "mcp"), "grant_invalid");

		const families = yield* auth.listTokenFamilies();
		assert.equal(families.items.find((item) => item.family === first.family)?.held_by, "mcp");
		assert.equal(families.items.find((item) => item.family === pair.family)?.held_by, null);

		// Revocation releases the grant's edit lock and ends authentication.
		yield* lock.acquire(first.family, "dot");
		const now2 = yield* Clock.currentTimeMillis;
		yield* sql`INSERT INTO sessions(id,hash,created_at,expires_at,last_seen_at,origin) VALUES('human','h',${now2},${now2 + 100_000},${now2},'https://comms.test')`;
		const revocation = yield* auth.startRevocationAssertion({ family: first.family });
		yield* auth.revokeFamily(
			{ family: first.family },
			{ id: revocation.id, response: device.assertion(revocation.options.challenge, ++counter) },
			"human",
		);
		assert.equal((yield* lock.inspect).value, null);
		yield* fails(auth.authenticateGrant(first.family, "mcp"), "grant_invalid");
		assert.deepEqual(yield* auth.collectHeldEnrollment(request.id, "mcp"), {
			status: "revoked",
			family: first.family,
		});
		assert.equal((yield* auth.listTokenFamilies()).items.find((item) => item.family === first.family)?.revoked, true);
	} else if (scenario === "lapse") {
		const denied = yield* held();
		yield* decide({ id: denied.id, decision: "deny", scopes: [], long_lived: false });
		assert.deepEqual(yield* auth.collectHeldEnrollment(denied.id, "mcp"), { status: "denied" });
		const stale = yield* held();
		yield* sql`UPDATE enrollments SET expires_at=${now - 1} WHERE id=${stale.id}`;
		assert.deepEqual(yield* auth.collectHeldEnrollment(stale.id, "mcp"), { status: "expired" });
		const late = yield* held();
		yield* approve(late.id);
		yield* sql`UPDATE enrollments SET expires_at=${now - 1} WHERE id=${late.id}`;
		assert.deepEqual(yield* auth.collectHeldEnrollment(late.id, "mcp"), { status: "expired" });
		assert.equal((yield* sql`SELECT id FROM tokens`).length, 0);
		// After 90 days the grant needs a new approval.
		const lapsed = yield* held();
		yield* approve(lapsed.id);
		const collected = yield* auth.collectHeldEnrollment(lapsed.id, "mcp");
		assert.ok(collected.status === "approved");
		yield* sql`UPDATE tokens SET expires_at=${now - 1} WHERE family=${collected.family}`;
		yield* fails(auth.authenticateGrant(collected.family, "mcp"), "grant_expired");
		assert.deepEqual(yield* auth.collectHeldEnrollment(lapsed.id, "mcp"), {
			status: "expired",
			family: collected.family,
		});
	} else if (scenario === "older-image") {
		// An older image's approval page would record refreshable lifetimes; this image never issues from that row.
		const request = yield* held();
		yield* sql`UPDATE enrollments SET status='approved',scopes='["read","write","fs"]',access_seconds=604800,refresh_seconds=7776000 WHERE id=${request.id}`;
		yield* fails(auth.collectHeldEnrollment(request.id, "mcp"), "enrollment_invalid");
		assert.equal((yield* sql`SELECT id FROM tokens`).length, 0);
		// Older collection code matches rows only by device-secret hash; nothing returned to the app is that preimage.
		const digest = (value: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(value))
				.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		const row = (yield* sql`SELECT device_secret_hash,family FROM enrollments WHERE id=${request.id}`.pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Array(Schema.Struct({ device_secret_hash: Schema.String, family: Schema.String })),
				),
			),
		))[0];
		assert.ok(row);
		for (const value of [request.id, row.family, "", "a".repeat(43)])
			assert.notEqual(yield* digest(value), row.device_secret_hash);
	}
});
await Effect.runPromise(
	run.pipe(
		Effect.scoped,
		Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename, disableWAL: true }), BunServices.layer)),
	),
);
await Effect.runPromise(Console.log("grant scenario passed"));
