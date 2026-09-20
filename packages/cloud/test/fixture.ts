import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as PgliteDrizzle from "drizzle-orm/effect-pglite";
import { Crypto, Effect, Layer, Redacted } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { type Boards, boardsLayer } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { type Deployments, deploymentsLayer } from "../src/deployments.ts";
import { type Invitations, invitationsLayer } from "../src/invitations.ts";
import { type Operations, operationsLayer } from "../src/operations.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
	throw new Error("CLOUD_TEST_DATABASE_URL is required in CI; refusing to skip PostgreSQL-only Cloud tests");
const sqlLayer = databaseUrl
	? PgClient.layer({
			url: Redacted.make(databaseUrl),
			maxConnections: 8,
			multiplex: false,
		})
	: PgliteClient.layer();
const databaseLayer = databaseUrl
	? Layer.effect(Database, PgDrizzle.makeWithDefaults()).pipe(Layer.provideMerge(sqlLayer))
	: Layer.effect(Database, PgliteDrizzle.makeWithDefaults()).pipe(Layer.provideMerge(sqlLayer));
export const cryptoLayer = Layer.succeed(
	Crypto.Crypto,
	Crypto.make({
		randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
		digest: (algorithm, data) =>
			Effect.promise(() => {
				const bytes = new Uint8Array(data.byteLength);
				bytes.set(data);
				return globalThis.crypto.subtle.digest(algorithm, bytes).then((value) => new Uint8Array(value));
			}),
	}),
);

const testLayer = Layer.mergeAll(boardsLayer, deploymentsLayer, invitationsLayer, operationsLayer).pipe(
	Layer.provideMerge(databaseLayer),
	Layer.provideMerge(cryptoLayer),
);

export const realPostgres = databaseUrl !== undefined;

export const runFresh = <A, E>(
	effect: Effect.Effect<A, E, Boards | Database | Deployments | Invitations | Operations | SqlClient.SqlClient>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const database = yield* Database;
			yield* database.execute(sql`DROP TABLE IF EXISTS passkey, "rateLimit", account, session, verification,
				"user", cloud_invitations, board_routes, board_deployments, board_operations, boards,
				cloud_migrations CASCADE`);
			return yield* effect;
		}).pipe(Effect.provide(testLayer)),
	);
