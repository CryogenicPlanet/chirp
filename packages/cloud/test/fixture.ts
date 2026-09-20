import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgliteClient from "@effect/sql-pglite/PgliteClient";
import { Crypto, Effect, Layer, Redacted } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { type Boards, boardsLayer } from "../src/boards.ts";
import { type Operations, operationsLayer } from "../src/operations.ts";

const databaseUrl = process.env.CLOUD_TEST_DATABASE_URL;
const databaseLayer = databaseUrl
	? PgClient.layer({
			url: Redacted.make(databaseUrl),
			maxConnections: 8,
			multiplex: false,
		})
	: PgliteClient.layer();
const cryptoLayer = Layer.succeed(
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

const testLayer = Layer.mergeAll(boardsLayer, operationsLayer).pipe(
	Layer.provideMerge(databaseLayer),
	Layer.provideMerge(cryptoLayer),
);

export const realPostgres = databaseUrl !== undefined;

export const runFresh = <A, E>(effect: Effect.Effect<A, E, Boards | Operations | SqlClient.SqlClient>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* sql`DROP TABLE IF EXISTS board_operations, boards, cloud_migrations CASCADE`;
			return yield* effect;
		}).pipe(Effect.provide(testLayer)),
	);
