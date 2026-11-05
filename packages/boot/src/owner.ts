import { lockBootWrite } from "./boot-write-lock.ts";
import { refuse } from "./auth-primitives.ts";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * The board's one human, by the name agents call them: their attribution and boot's reserved enrollment name. First
 * setup records it in boot's settings table with the first passkey, and nothing renames it afterwards. Read it from the
 * database each time, inside the caller's transaction when there is one, so no copy of it can go stale.
 */
export const ownerKey = "owner_name";
/** Every image before the owner was named called the human this, so boards set up then keep it with their history. */
export const legacyOwner = "rahul";
const reserved: ReadonlyArray<string> = ["boot", "system"];
/** Agent names' grammar. Boot and system speak for the board itself. */
export const validOwnerName = (name: string) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) && !reserved.includes(name);

const Row = Schema.Array(Schema.Struct({ value: Schema.String }));
/** Null until first setup names the owner. */
export const readOwner = (sql: SqlClient.SqlClient) =>
	sql`SELECT value FROM settings WHERE ${sql("key")}=${ownerKey}`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Row)),
		Effect.map((rows) => rows[0]?.value ?? null),
	);
/** For actions only a signed-in human can take, which exist only after setup named the owner. */
export const requireOwner = (sql: SqlClient.SqlClient) =>
	readOwner(sql).pipe(
		Effect.filterOrElse(
			(owner): owner is string => owner !== null,
			() => refuse("setup_required"),
		),
	);

/** A name some agent already holds or may still be granted: one with credentials, or an approval or live request for them. */
export const agentNameTaken = (sql: SqlClient.SqlClient, name: string, now: number) =>
	Effect.map(
		sql`SELECT agent AS name FROM tokens WHERE agent=${name}
 UNION ALL SELECT agent_name AS name FROM enrollments WHERE agent_name=${name}
 AND (status IN ('approved','collected') OR (status='pending' AND expires_at>${now}))`,
		(rows) => rows.length > 0,
	);

/** Inside first setup's transaction, before the passkey commits with it. */
export const recordOwner = (sql: SqlClient.SqlClient, name: string) =>
	sql`INSERT INTO settings (${sql("key")}, value) VALUES (${ownerKey}, ${name})`.pipe(Effect.asVoid);

/**
 * Run at startup. A board that finished setup under an image that did not ask (it has a passkey, a session or a token)
 * is the legacy owner's, with no human action. A board that has not finished setup names its owner at setup.
 */
export const recordLegacyOwner = (sql: SqlClient.SqlClient) =>
	sql.withTransaction(
		Effect.gen(function* () {
			yield* lockBootWrite(sql);
			if ((yield* readOwner(sql)) !== null) return;
			const evidence = yield* sql`SELECT 1 AS found FROM passkeys
 UNION ALL SELECT 1 AS found FROM sessions
 UNION ALL SELECT 1 AS found FROM tokens LIMIT 1`;
			if (evidence.length > 0) yield* recordOwner(sql, legacyOwner);
		}),
	);

/** How the app is told at launch: a JSON string, or null until setup. An environment variable cannot carry an empty
 * value reliably, and an absent one means a boot from before the owner was named. */
export const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(Schema.String)));

/** The owner as read from boot's own store, for code that does not hold boot's client, such as the child launcher. */
export class Owner extends Context.Service<
	Owner,
	{ readonly name: Effect.Effect<string | null, Effect.Error<ReturnType<typeof readOwner>>> }
>()("comms/Owner") {}
export const layer = Layer.effect(
	Owner,
	Effect.map(SqlClient.SqlClient, (sql) => ({ name: readOwner(sql) })),
);
