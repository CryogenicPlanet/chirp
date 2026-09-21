import { type Redacted, Schema } from "effect";

export const StorageEngine = Schema.Literals(["sqlite", "postgres", "mysql"]);
export type StorageEngine = typeof StorageEngine.Type;

export const Board = Schema.Struct({
	id: Schema.String,
	owner_id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	storage_engine: StorageEngine,
	created_at: Schema.DateFromString,
});
export type Board = typeof Board.Type;

export const RequestBoard = Schema.Struct({
	owner_id: Schema.String,
	name: Schema.String,
	storage_engine: StorageEngine,
	requested_by: Schema.String,
	idempotency_key: Schema.String,
});
export type RequestBoard = typeof RequestBoard.Type & { readonly postgres_admin_url?: Redacted.Redacted<string> };
