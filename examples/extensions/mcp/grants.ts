import { on } from "@comms/storage/dialect";
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Api, ManagedRequestContext } from "../../../packages/server/src/kernel/extension-api.ts";

type Context = ManagedRequestContext;
const GrantScope = Schema.Literals(["read", "write", "fs"]);
const Row = Schema.Struct({
	client_id: Schema.String,
	subject: Schema.String,
	request_id: Schema.String,
	approve_url: Schema.String,
	code: Schema.NullOr(Schema.String),
	agent: Schema.String,
	family: Schema.NullOr(Schema.String),
	scopes: Schema.String,
	status: Schema.Literals(["pending", "active", "expired", "revoked", "denied"]),
	expires_at: Schema.Finite,
	created_at: Schema.Finite,
	updated_at: Schema.Finite,
});
type Row = typeof Row.Type;
export type EditingStatus = "none" | Row["status"];
/** A connection's editing grant as the extension knows it. The family stays internal: it is a capability of the app. */
export interface Editing {
	readonly status: EditingStatus;
	readonly agent: string | null;
	readonly scopes: ReadonlyArray<typeof GrantScope.Type>;
	readonly expires_at: number | null;
	readonly code: string | null;
	readonly approve_url: string | null;
	readonly family: string | null;
}
const none: Editing = {
	status: "none",
	agent: null,
	scopes: [],
	expires_at: null,
	code: null,
	approve_url: null,
	family: null,
};
const scopesOf = (value: string) =>
	value.split(" ").filter((scope): scope is typeof GrantScope.Type => Schema.is(GrantScope)(scope));
/**
 * Whose grant: the MCP connection, the human who approved it and the name it acts as. A grant is used, collected and
 * reported only for the identity it was requested for, so a client re-authorized by another human or under another
 * posting name never acts through an earlier approval.
 */
export interface GrantHolder {
	readonly clientId: string;
	readonly subject: string;
	readonly agent: string | undefined;
}
const view = (row: Row): Editing => ({
	status: row.status,
	agent: row.agent,
	scopes: scopesOf(row.scopes),
	expires_at: row.expires_at,
	code: row.code,
	approve_url: row.status === "pending" ? row.approve_url : null,
	family: row.status === "active" ? row.family : null,
});

/** One grant per MCP connection, bound to the approving human and posting name; requesting again replaces the row. */
export const installGrants = (api: Api) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* api.migrate(
			"agent_grants",
			on(sql, {
				sqlite: () =>
					"CREATE TABLE example_mcp_grants(client_id TEXT PRIMARY KEY,subject TEXT NOT NULL,request_id TEXT NOT NULL,approve_url TEXT NOT NULL,code TEXT,agent TEXT NOT NULL,family TEXT,scopes TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
				pg: () =>
					"CREATE TABLE example_mcp_grants(client_id TEXT PRIMARY KEY,subject TEXT NOT NULL,request_id TEXT NOT NULL,approve_url TEXT NOT NULL,code TEXT,agent TEXT NOT NULL,family TEXT,scopes TEXT NOT NULL,status TEXT NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL)",
				mysql: () =>
					"CREATE TABLE example_mcp_grants(client_id VARCHAR(128) PRIMARY KEY,subject VARCHAR(64) NOT NULL,request_id VARCHAR(64) NOT NULL,approve_url LONGTEXT NOT NULL,code VARCHAR(32),agent VARCHAR(64) NOT NULL,family VARCHAR(64),scopes VARCHAR(32) NOT NULL,status VARCHAR(16) NOT NULL,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
			}),
			{ protect: true },
		);
	});

const stored = (ctx: Context, holder: GrantHolder) =>
	ctx.db`SELECT client_id,subject,request_id,approve_url,code,agent,family,scopes,status,expires_at,created_at,updated_at FROM example_mcp_grants WHERE client_id=${holder.clientId} AND subject=${holder.subject} AND agent=${holder.agent ?? ""}`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Row))),
		Effect.map((rows) => rows[0]),
	);

/** What boot says about a stored request now. A request boot no longer knows is treated as revoked. */
const collected = (ctx: Context, row: Row) =>
	ctx.agentGrants.collect(row.request_id).pipe(
		Effect.map((result): Row => {
			if (result.status === "pending") return { ...row, status: "pending", expires_at: result.expires_at };
			if (result.status === "approved")
				return {
					...row,
					status: "active",
					family: result.family,
					scopes: result.scopes.join(" "),
					expires_at: result.expires_at,
				};
			return { ...row, status: result.status, family: result.family ?? row.family };
		}),
		Effect.catchTag("KernelError", (error) =>
			error.code === "input_invalid" ? Effect.succeed<Row>({ ...row, status: "revoked" }) : Effect.fail(error),
		),
	);

/** The holder's grant as last recorded, without asking boot. */
export const storedEditing = (ctx: Context, holder: GrantHolder) =>
	stored(ctx, holder).pipe(Effect.map((row) => (row && holder.agent !== undefined ? view(row) : none)));
/**
 * The connection's grant, collected lazily: a pending request is asked about on every call, and an active grant
 * when `refresh` is set or its expiry has passed. A change is recorded unless `readOnly`, as a GET request must be.
 */
export const editingState = (
	ctx: Context,
	holder: GrantHolder,
	options: { readonly refresh?: boolean; readonly readOnly?: boolean } = {},
) =>
	Effect.gen(function* () {
		// A connection without a posting name holds no grant; any other identity's row reads as none.
		const row = holder.agent === undefined ? undefined : yield* stored(ctx, holder);
		if (!row) return none;
		const now = yield* Clock.currentTimeMillis;
		if (row.status !== "pending" && !(row.status === "active" && (options.refresh || row.expires_at <= now)))
			return view(row);
		const next = yield* collected(ctx, row);
		if (
			!options.readOnly &&
			(next.status !== row.status ||
				next.family !== row.family ||
				next.scopes !== row.scopes ||
				next.expires_at !== row.expires_at)
		)
			yield* ctx.mutate(
				ctx.db`UPDATE example_mcp_grants SET status=${next.status},family=${next.family},scopes=${next.scopes},expires_at=${next.expires_at},updated_at=${now} WHERE client_id=${holder.clientId} AND request_id=${row.request_id}`,
			);
		return view(next);
	});

/**
 * Asks boot for a grant acting as `agent`, replacing any earlier one for this connection. The human narrows the
 * scopes on boot's page, where fs starts unticked. The approval link is given on the board origin, where the
 * human holds the passkey session that the consent continuation needs.
 */
export const requestEditing = (
	ctx: Context,
	origin: string,
	holder: GrantHolder & { readonly agent: string },
	label: string,
) =>
	Effect.gen(function* () {
		const created = yield* ctx.agentGrants.request({ agent: holder.agent, label, scopes: ["read", "write", "fs"] });
		const now = yield* Clock.currentTimeMillis;
		const row: Row = {
			client_id: holder.clientId,
			subject: holder.subject,
			request_id: created.id,
			approve_url: `${origin}${new URL(created.approve_url).pathname}`,
			code: created.user_code,
			agent: holder.agent,
			family: null,
			scopes: "read write fs",
			status: "pending",
			expires_at: created.expires_at,
			created_at: now,
			updated_at: now,
		};
		yield* ctx.mutate(
			Effect.gen(function* () {
				yield* ctx.db`DELETE FROM example_mcp_grants WHERE client_id=${row.client_id}`;
				yield* ctx.db`INSERT INTO example_mcp_grants(client_id,subject,request_id,approve_url,code,agent,family,scopes,status,expires_at,created_at,updated_at) VALUES(${row.client_id},${row.subject},${row.request_id},${row.approve_url},${row.code},${row.agent},${row.family},${row.scopes},${row.status},${row.expires_at},${row.created_at},${row.updated_at})`;
			}),
		);
		return view(row);
	});

const Refusal = Schema.Struct({
	error: Schema.Struct({
		code: Schema.String,
		message: Schema.optionalKey(Schema.String),
		hint: Schema.optionalKey(Schema.String),
		retriable: Schema.optionalKey(Schema.Boolean),
	}),
});
/** A board response read through a grant: its status, headers, text, and JSON body when it has one. */
export interface BoardReply {
	readonly status: number;
	readonly headers: Headers;
	readonly text: string;
	readonly json: Option.Option<unknown>;
	readonly refusal: typeof Refusal.Type.error | undefined;
}
/** Calls the board as the connection's agent. Boot attributes the call and enforces the grant's scopes. */
export const asAgent = (
	ctx: Context,
	family: string,
	path: `/${string}`,
	init: { readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string } = {},
) =>
	ctx.agentGrants
		.fetch(family, path, {
			...init,
			headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
		})
		.pipe(
			// Boot buffers the whole body before handing the response over, so reading it cannot fail.
			Effect.flatMap((response) =>
				Effect.promise(() => response.text()).pipe(
					Effect.map((text): BoardReply => {
						const json = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(text);
						return {
							status: response.status,
							headers: response.headers,
							text,
							json,
							refusal:
								response.status >= 400
									? Option.getOrUndefined(Option.flatMap(json, Schema.decodeUnknownOption(Refusal)))?.error
									: undefined,
						};
					}),
				),
			),
		);
/** A refusal that means the grant itself is gone, so the stored state needs collecting again. */
export const grantEnded = (reply: BoardReply) =>
	reply.status === 401 && (reply.refusal?.code === "grant_invalid" || reply.refusal?.code === "grant_expired");
