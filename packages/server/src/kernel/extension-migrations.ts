import { extensionChecksums } from "./extension-checksum.ts";
import { on } from "@comms/storage/dialect";
import { assertNoPendingMigration, mysqlMigration } from "./migration-intent.ts";
import { Effect, Schema, Semaphore } from "effect";
import { preserveMigrationState } from "./migration-state.ts";
import type { SqlClient } from "effect/unstable/sql";
import { KernelError } from "./boot-channel.ts";
import { registerProtectedSqlTable } from "./protected-sql-tables.ts";
import { extensionProtection } from "./protection-ownership.ts";
import { writerGate } from "./database.ts";

/** Loader-only migrations share the startup writer fence; they never publish candidate events. */
export const makeExtensionMigrate = (sql: SqlClient.SqlClient, epoch: string, extension: string) =>
	Effect.gen(function* () {
		const gate = yield* Semaphore.make(1);
		return (
			name: string,
			statement: string,
			options?: {
				readonly protect?: boolean;
				readonly unprotect?: string;
				readonly alternateStatements?: ReadonlyArray<string>;
				readonly skipIfColumnExists?: { readonly table: string; readonly column: string };
			},
		) =>
			Effect.gen(function* () {
				if (
					!name ||
					name.length > 128 ||
					Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
				)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				// Bun's SQL client executes only the first statement. Refuse scripts rather than record a partial migration.
				if (
					Buffer.byteLength(statement) > 65536 ||
					statement.includes("\0") ||
					/;|--|\/\*/.test(statement) ||
					!/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|WITH)\b/i.test(statement)
				)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				const table = options?.protect
					? /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]{0,127})\s*\(/i.exec(statement)?.[1]
					: undefined;
				if (options?.protect && table === undefined)
					return yield* new KernelError({ code: "extension_migration_invalid" });
				const { checksum, legacyChecksum } = yield* extensionChecksums(statement, options);
				const alternateChecksums = options?.alternateStatements
					? yield* Effect.forEach(options.alternateStatements, (stmt) => extensionChecksums(stmt, options))
					: [];
				const mysql = on(sql, { sqlite: () => false, pg: () => false, mysql: () => true });
				const prior = sql.withTransaction(
					Effect.gen(function* () {
						yield* writerGate(sql, epoch);
						yield* assertNoPendingMigration(sql);
						yield* on(sql, {
							sqlite: () =>
								sql`CREATE TABLE IF NOT EXISTS extension_migrations(extension TEXT NOT NULL,name TEXT NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(extension,name))`.pipe(
									Effect.asVoid,
								),
							pg: () => Effect.void,
							mysql: () => Effect.void,
						});
						const previous =
							yield* sql`SELECT checksum FROM extension_migrations WHERE extension=${extension} AND name=${name}`.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ checksum: Schema.String })))),
							);
						if (previous.length > 0) {
							const priorChecksum = previous[0]?.checksum;
							const isAlternate = alternateChecksums.some(
								(alt) => alt.checksum === priorChecksum || alt.legacyChecksum === priorChecksum,
							);
							if (
								priorChecksum !== checksum &&
								!(options?.unprotect === undefined && priorChecksum === legacyChecksum) &&
								!isAlternate
							)
								return yield* new KernelError({ code: "extension_migration_conflict" });
							return true;
						}
						// IF NOT EXISTS cannot adopt someone else's existing object.
						if (
							table !== undefined &&
							(yield* on(sql, {
								sqlite: () => sql`SELECT name FROM sqlite_schema WHERE name=${table} COLLATE NOCASE`,
								pg: () =>
									sql`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND lower(c.relname)=lower(${table}::text)`,
								mysql: () =>
									sql`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND lower(TABLE_NAME)=lower(${table})`,
							})).length
						)
							return yield* new KernelError({ code: "extension_migration_invalid" });
						yield* extensionProtection(sql, extension, statement, options?.unprotect);
						return false;
					}),
				);
				let finishProtection: Effect.Effect<void, Effect.Error<ReturnType<typeof extensionProtection>>> = Effect.void;
				const columnCheck = options?.skipIfColumnExists;
				const skipColumnCheck =
					columnCheck !== undefined
						? Effect.gen(function* () {
								const { table: tableName, column: columnName } = columnCheck;
								return yield* on(sql, {
									sqlite: () =>
										sql`SELECT name FROM pragma_table_info(${tableName}) WHERE lower(name)=lower(${columnName})`.pipe(
											Effect.map((rows) => rows.length > 0),
										),
									pg: () =>
										sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND lower(table_name)=lower(${tableName}) AND lower(column_name)=lower(${columnName})`.pipe(
											Effect.map((rows) => rows.length > 0),
										),
									mysql: () =>
										sql`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND lower(TABLE_NAME)=lower(${tableName}) AND lower(COLUMN_NAME)=lower(${columnName})`.pipe(
											Effect.map((rows) => rows.length > 0),
										),
								});
							})
						: Effect.succeed(false);
				const operation = Effect.gen(function* () {
					const columnExists = yield* skipColumnCheck;
					if (columnExists) {
						finishProtection = Effect.void;
						return;
					}
					const protection = yield* extensionProtection(sql, extension, statement, options?.unprotect);
					yield* preserveMigrationState(sql, sql.unsafe(statement), protection.tables);
					finishProtection = protection.receipt;
				});
				const receipt = Effect.gen(function* () {
					yield* finishProtection;
					if (table !== undefined) yield* registerProtectedSqlTable(sql, table, { extension, migration: name });
					yield* sql`INSERT INTO extension_migrations(extension,name,checksum) VALUES(${extension},${name},${checksum})`;
				});
				if (mysql) {
					if (yield* prior) return;
					return yield* mysqlMigration(sql, epoch, extension, name, sql.withTransaction(operation), receipt);
				}
				yield* sql.withTransaction(
					Effect.gen(function* () {
						if (yield* prior) return;
						yield* operation;
						yield* receipt;
					}),
				);
			}).pipe(gate.withPermit);
	});
