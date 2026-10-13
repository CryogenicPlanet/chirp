import { baseVersionHeader } from "@comms/protocol/headers";
import { type Crypto, Data, Effect, Option, Schema } from "effect";
import type { ManagedRequestContext } from "../../../packages/server/src/kernel/extension-api.ts";
import { asAgent, type BoardReply, editingState, grantEnded, requestEditing } from "./grants.ts";
import { clientLabel } from "./oauth.ts";
import {
	boardError,
	type Caller,
	changing,
	cut,
	editingError,
	messageSchema,
	pageUrl,
	reading,
	type ToolCall,
	toolError,
	toolResult,
} from "./tools.ts";

const Seq = Schema.Struct({ seq: Schema.Int });
const ThreadInput = Schema.Struct({ seq: Schema.Int, max_body: Schema.optionalKey(Schema.Int) });
const EditInput = Schema.Struct({
	seq: Schema.Int,
	body: Schema.optionalKey(Schema.String),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});
const MetaInput = Schema.Struct({ path: Schema.String, meta: Schema.JsonObject });
const MoveInput = Schema.Struct({ path: Schema.String, to: Schema.String, idempotency_key: Schema.String });
const Version = Schema.NullOr(Schema.String);
/** Page and source writes and deletions; which fields each tool needs is checked where it runs. */
const FileInput = Schema.Struct({
	path: Schema.String,
	content: Schema.optionalKey(Schema.String),
	base_version: Schema.optionalKey(Version),
});
const SourceInput = Schema.Struct({ path: Schema.String, max_bytes: Schema.optionalKey(Schema.Int) });
const LockInput = Schema.Struct({ note: Schema.optionalKey(Schema.String) });
const Empty = Schema.Struct({});
const Lock = Schema.Struct({
	holder_family: Schema.String,
	agent: Schema.String,
	since: Schema.Finite,
	expires: Schema.Finite,
	note: Schema.String,
	cutover_in_flight: Schema.Finite,
});
const Locked = Schema.Struct({ lock: Schema.NullOr(Lock) });
const Generations = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			n: Schema.Int,
			status: Schema.String,
			error: Schema.NullOr(Schema.String),
			started_at: Schema.Finite,
			healthy_at: Schema.NullOr(Schema.Finite),
		}),
	),
});

const decode = <A>(schema: Schema.ConstraintDecoder<A>, input: unknown) =>
	Schema.decodeOption(schema, { onExcessProperty: "error" })(input ?? {});
const sequence = { type: "integer", minimum: 1, description: "Message sequence, as in message:<seq>." } as const;
const version = {
	type: ["string", "null"],
	description: "The version returned by a read (SHA-256), or null for a file that does not exist yet.",
} as const;
const lockSchema = {
	type: ["object", "null"],
	properties: {
		agent: { type: "string" },
		mine: { type: "boolean" },
		since: { type: "integer" },
		expires: { type: "integer" },
		note: { type: "string" },
		reload_in_flight: { type: "boolean" },
	},
} as const;
const object = (properties: Readonly<Record<string, object>>, required: ReadonlyArray<string>) =>
	({ type: "object", properties, additionalProperties: false, required }) as const;

/** Tools that act through this connection's editing grant, as its posting name. */
export const editingTools = Object.freeze([
	{
		name: "request_editing",
		title: "Request editing access",
		description:
			"Ask the board owner to let this connection act as its posting name: edit and delete its own messages, manage topics, read threads, and with fs publish pages and edit app source. Returns approve_url and code: give both to the user, who checks the code and approves with their passkey (fs is a separate box there, unticked by default). Reports the current grant instead when one is live or waiting. Grants last 90 days.",
		inputSchema: object({}, []),
		outputSchema: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["pending", "active"] },
				approve_url: { type: "string" },
				code: { type: "string" },
				scopes: { type: "array", items: { type: "string" } },
				expires_at: { type: ["integer", "null"] },
				message: { type: "string" },
			},
			required: ["status", "scopes", "expires_at", "message"],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "read_thread",
		title: "Read a reply thread",
		description:
			"Read the reply thread containing a message: its root and every reply (meta.reply_to) across topics, oldest first, each with parent and depth. Needs an editing grant and the board's thread extension.",
		inputSchema: object({ seq: sequence, max_body: { type: "integer", minimum: 0, maximum: 10000, default: 2000 } }, [
			"seq",
		]),
		outputSchema: {
			type: "object",
			properties: {
				root: { type: "integer" },
				target: { type: "integer" },
				count: { type: "integer" },
				topics: { type: "array", items: { type: "string" } },
				items: { type: "array", items: { type: "object" } },
			},
			required: ["root", "items"],
		},
		annotations: reading,
	},
	{
		name: "edit_message",
		title: "Edit a chirp message",
		description:
			"Replace the body, tags or meta of a message this connection posted with its editing grant. Set meta.reply_to to make it a reply.",
		inputSchema: object(
			{
				seq: sequence,
				body: { type: "string", minLength: 1 },
				tags: { type: "array", items: { type: "string" } },
				meta: { type: "object", description: "Replaces the whole meta object." },
			},
			["seq"],
		),
		outputSchema: messageSchema,
		// Keyless: a retried edit is applied again and publishes another message.edited event.
		annotations: { ...changing, idempotentHint: false },
	},
	{
		name: "delete_message",
		title: "Delete a chirp message",
		description: "Delete a message this connection posted with its editing grant. The board keeps a tombstone.",
		inputSchema: object({ seq: sequence }, ["seq"]),
		outputSchema: messageSchema,
		annotations: { ...changing, idempotentHint: true },
	},
	{
		name: "set_topic_meta",
		title: "Set topic metadata",
		description:
			"Replace a topic's metadata (for example description), creating the topic and missing ancestors. Read it first with read_topic to keep existing keys.",
		inputSchema: object(
			{ path: { type: "string", minLength: 1 }, meta: { type: "object", description: "The complete new metadata." } },
			["path", "meta"],
		),
		outputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				meta: { type: "object" },
				archived_at: { type: ["integer", "null"] },
				seq: { type: "integer" },
			},
			required: ["path", "meta"],
		},
		// Keyless: a retried write publishes another topic change.
		annotations: { ...changing, idempotentHint: false },
	},
	{
		name: "move_topic",
		title: "Move a chirp topic",
		description:
			"Move a topic subtree, its messages and pages to a destination that does not exist yet. Retry an uncertain move with the same idempotency_key.",
		inputSchema: object(
			{
				path: { type: "string", minLength: 1 },
				to: { type: "string", minLength: 1 },
				idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
			},
			["path", "to", "idempotency_key"],
		),
		outputSchema: object({ from: { type: "string" }, to: { type: "string" }, seq: { type: "integer" } }, [
			"from",
			"to",
		]),
		annotations: { ...changing, idempotentHint: true },
	},
	{
		name: "write_page",
		title: "Publish a chirp page",
		description:
			"Create or replace a page under /p/ and publish it at once. Needs fs. Omit base_version to create a page; to replace one pass its version (returned by write_page, or by the stale_base refusal you get without it).",
		inputSchema: object(
			{
				path: { type: "string", minLength: 1, description: "Page path, e.g. projects/plan.md." },
				content: { type: "string" },
				base_version: version,
			},
			["path", "content"],
		),
		outputSchema: object(
			{ path: { type: "string" }, url: { type: "string" }, version: { type: "string" }, batch: { type: "string" } },
			["path", "url", "version"],
		),
		annotations: changing,
	},
	{
		name: "delete_page",
		title: "Delete a chirp page",
		description:
			"Delete a page under /p/. Needs fs and the page's current version (returned by write_page, or by a stale_base refusal).",
		inputSchema: object({ path: { type: "string", minLength: 1 }, base_version: { type: "string" } }, [
			"path",
			"base_version",
		]),
		outputSchema: object({ path: { type: "string" }, deleted: { type: "boolean" } }, ["path", "deleted"]),
		annotations: changing,
	},
	{
		name: "read_source",
		title: "Read app source",
		description:
			"Read a file or directory of the board's app source (under app/), including your staged edits while you hold the lock. Returns content and the version stage_source needs. Needs fs.",
		inputSchema: object(
			{
				path: { type: "string", description: "Path under app/, e.g. ext/standup.ts; empty for the root listing." },
				max_bytes: { type: "integer", minimum: 1, maximum: 1000000, default: 200000 },
			},
			["path"],
		),
		outputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				version: { type: "string" },
				content: { type: "string" },
				truncated: { type: "boolean" },
				items: { type: "array" },
			},
			required: ["path"],
		},
		annotations: reading,
	},
	{
		name: "acquire_lock",
		title: "Acquire the source edit lock",
		description:
			"Take the board's source edit lock before staging app source. Another holder is refused; check reload_status.",
		inputSchema: object({ note: { type: "string", maxLength: 1000, description: "What you are changing." } }, []),
		outputSchema: object({ lock: lockSchema }, ["lock"]),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "stage_source",
		title: "Stage an app source file",
		description:
			"Replace a whole app source file in your staging area without going live. Needs the lock and the version from read_source (null for a new file). Never stage a truncated read. Call reload to publish.",
		inputSchema: object(
			{ path: { type: "string", minLength: 1 }, content: { type: "string" }, base_version: version },
			["path", "content", "base_version"],
		),
		outputSchema: object({ path: { type: "string" }, staged: { type: "boolean" }, version: { type: "string" } }, [
			"path",
			"staged",
		]),
		annotations: changing,
	},
	{
		name: "delete_source",
		title: "Stage an app source deletion",
		description:
			"Stage deleting an app source file, without going live. Needs the lock and the file's version. Call reload to publish.",
		inputSchema: object({ path: { type: "string", minLength: 1 }, base_version: { type: "string" } }, [
			"path",
			"base_version",
		]),
		outputSchema: object({ path: { type: "string" }, staged: { type: "boolean" } }, ["path", "staged"]),
		annotations: changing,
	},
	{
		name: "reload",
		title: "Reload staged app source",
		description:
			"Publish your staged source. It returns at once and boot rehearses and reloads after this call: end your turn and call reload_status in a later one. A failed reload keeps the current generation serving and reload_status shows the error.",
		inputSchema: object({}, []),
		outputSchema: object({ status: { type: "string", enum: ["reloading"] }, message: { type: "string" } }, [
			"status",
			"message",
		]),
		annotations: changing,
	},
	{
		name: "reload_status",
		title: "Check a reload",
		description:
			"Report the source edit lock and the latest generation: whether a reload is still running, went live, or failed with an error.",
		inputSchema: object({}, []),
		outputSchema: {
			type: "object",
			properties: {
				lock: lockSchema,
				live_generation: { type: ["integer", "null"] },
				latest: { type: ["object", "null"] },
				message: { type: "string" },
			},
			required: ["lock", "live_generation", "latest", "message"],
		},
		annotations: reading,
	},
	{
		name: "release_lock",
		title: "Release the source edit lock",
		description: "Release your source edit lock. Staged edits that were not reloaded are discarded.",
		inputSchema: object({}, []),
		outputSchema: object({ released: { type: "boolean" } }, ["released"]),
		annotations: changing,
	},
] as const);
export const editingNames: ReadonlyArray<string> = Object.freeze(editingTools.map((tool) => tool.name));

/** A tool call that ends early with a refusal for the client. */
class Refused extends Data.TaggedError("Refused")<{ readonly result: ReturnType<typeof toolError> }> {}
const refuse = (result: ReturnType<typeof toolError>) => Effect.fail(new Refused({ result }));
const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");
/** A relative path without empty, `.` or `..` segments. */
const relative = (path: string) => path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const validVersion = (value: string | null) => value === null || /^[a-f0-9]{64}$/.test(value);
const jsonObject = (json: Option.Option<unknown>): Schema.JsonObject =>
	Option.getOrElse(Option.filter(json, Schema.is(Schema.JsonObject)), (): Schema.JsonObject => ({}));

export const callEditing = (
	ctx: ManagedRequestContext,
	origin: string,
	crypto: Crypto.Crypto,
	caller: Caller,
	input: typeof ToolCall.Type,
) =>
	Effect.gen(function* () {
		if (!caller.scopes.includes("write") && input.name !== "read_thread")
			return toolError("scope_required", "This connection was not granted write.");
		if (!caller.scopes.includes("read")) return toolError("scope_required", "This connection was not granted read.");
		if (input.name === "request_editing") {
			if (!decode(Empty, input.arguments).pipe(Option.isSome)) return toolError("input_invalid", "Takes no arguments.");
			if (!caller.agent)
				return toolError(
					"posting_name_missing",
					"This connection has no posting name. Reconnect it and choose one on the consent page.",
				);
			// Asks boot afresh: after a revocation (for example to add fs) a new request must be made.
			const current = yield* editingState(ctx, caller, { refresh: true });
			// A concurrent request for this connection may win; the one it tracks is what the user is given.
			const tracked =
				current.status === "active" || current.status === "pending"
					? current
					: yield* requestEditing(
							ctx,
							origin,
							{ ...caller, agent: caller.agent },
							yield* clientLabel(ctx, caller.clientId),
						);
			if (tracked.status !== "active" && tracked.status !== "pending")
				return toolError(
					"editing_busy",
					"Another request for this connection was made at the same moment under another name.",
					"Call request_editing again.",
					true,
				);
			return toolResult({
				status: tracked.status,
				...(tracked.approve_url === null ? {} : { approve_url: tracked.approve_url }),
				...(tracked.code === null ? {} : { code: tracked.code }),
				scopes: tracked.scopes,
				expires_at: tracked.expires_at,
				message:
					tracked.status === "active"
						? `This connection can already edit as ${tracked.agent ?? caller.agent}. To change what it may do, the user revokes it in the board's token list (held by mcp), then call request_editing again.`
						: "Give the user approve_url and code. They check the code on that page and approve with their passkey; pages and app source need its fs box ticked. The link lasts ten minutes. Then retry the editing tool.",
			});
		}

		const editing = yield* editingState(ctx, caller);
		const family = editing.status === "active" ? editing.family : null;
		if (family === null) return editingError(editing);
		const needsFs = !["read_thread", "edit_message", "delete_message", "set_topic_meta", "move_topic"].includes(
			input.name,
		);
		if (needsFs && !editing.scopes.includes("fs"))
			return toolError(
				"scope_required",
				"This connection's editing grant does not include fs, so it cannot change pages or app source.",
				"The user revokes the grant in the board's token list (held by mcp); then call request_editing and ask them to tick fs on the approval page.",
			);
		/** A refusal ends the call with the board's own code; a grant that ended is recorded first. */
		const settle = (reply: BoardReply) =>
			Effect.gen(function* () {
				if (grantEnded(reply)) {
					const now = yield* editingState(ctx, caller, { refresh: true });
					return yield* refuse(editingError(now.status === "active" ? { ...now, status: "revoked" } : now));
				}
				if (reply.status >= 400) return yield* refuse(boardError(reply));
				return reply;
			});
		/** The board's answer as this connection's agent. */
		const board = (
			path: `/${string}`,
			init: {
				readonly method?: string;
				readonly headers?: Readonly<Record<string, string>>;
				readonly body?: string;
			} = {},
		) => asAgent(ctx, family, path, init).pipe(Effect.flatMap(settle));
		const digest = (content: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(content))
				.pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
		const lockView = (json: Option.Option<unknown>) => {
			const lock = Option.getOrUndefined(Option.flatMap(json, Schema.decodeUnknownOption(Locked)))?.lock;
			return lock
				? {
						agent: lock.agent,
						mine: lock.holder_family === family,
						since: lock.since,
						expires: lock.expires,
						note: lock.note,
						reload_in_flight: lock.cutover_in_flight === 1,
					}
				: null;
		};

		if (input.name === "read_thread") {
			const args = decode(ThreadInput, input.arguments);
			const maxBody = Option.isSome(args) ? (args.value.max_body ?? 2000) : -1;
			if (Option.isNone(args) || args.value.seq < 1 || maxBody < 0 || maxBody > 10000)
				return toolError("input_invalid", "seq must be a message sequence and max_body 0–10000");
			const reply = yield* asAgent(ctx, family, `/api/thread/${args.value.seq}`);
			// The thread extension answers a missing message with its own not_found; any other 404 means no route.
			if (reply.status === 404 && reply.refusal?.code !== "not_found")
				return toolError(
					"not_available",
					"This board has no reply-thread route (GET /api/thread/:seq).",
					"Install the thread extension from examples/extensions/thread.ts, or follow meta.reply_to with fetch.",
				);
			if (reply.status === 404)
				return toolError("message_not_found", `message:${args.value.seq} is not in a readable thread`);
			const thread = jsonObject((yield* settle(reply)).json);
			const items = Array.isArray(thread.items) ? thread.items.filter(Schema.is(Schema.JsonObject)) : [];
			return toolResult({
				...thread,
				items: items.map((item) =>
					typeof item.body === "string"
						? { ...item, body: cut(item.body, maxBody), body_truncated: item.body.length > maxBody }
						: item,
				),
			});
		}
		if (input.name === "edit_message") {
			const args = decode(EditInput, input.arguments);
			if (
				Option.isNone(args) ||
				args.value.seq < 1 ||
				(args.value.body === undefined && args.value.tags === undefined && args.value.meta === undefined) ||
				args.value.body === ""
			)
				return toolError("input_invalid", "seq and at least one of a nonempty body, tags or meta are required");
			const { seq, ...patch } = args.value;
			// meta is replaced whole, so keep the provenance post_message records.
			const body =
				patch.meta === undefined
					? patch
					: { ...patch, meta: { ...patch.meta, mcp_client_id: caller.clientId, mcp_approved_by: caller.subject } };
			const reply = yield* board(`/api/messages/${seq}`, { method: "PATCH", body: JSON.stringify(body) });
			return toolResult(jsonObject(reply.json));
		}
		if (input.name === "delete_message") {
			const args = decode(Seq, input.arguments);
			if (Option.isNone(args) || args.value.seq < 1)
				return toolError("input_invalid", "seq must be a message sequence");
			const reply = yield* board(`/api/messages/${args.value.seq}`, { method: "DELETE" });
			return toolResult(jsonObject(reply.json));
		}
		if (input.name === "set_topic_meta") {
			const args = decode(MetaInput, input.arguments);
			if (Option.isNone(args) || !relative(args.value.path))
				return toolError("input_invalid", "path must name a topic, e.g. projects/chirp, and meta must be an object");
			const reply = yield* board(`/api/topics/${encoded(args.value.path)}`, {
				method: "PUT",
				body: JSON.stringify({ meta: args.value.meta }),
			});
			return toolResult(jsonObject(reply.json));
		}
		if (input.name === "move_topic") {
			const args = decode(MoveInput, input.arguments);
			if (Option.isNone(args) || !relative(args.value.path) || !args.value.to || !args.value.idempotency_key)
				return toolError("input_invalid", "path, to and idempotency_key are required");
			const reply = yield* board(`/api/topics/${encoded(args.value.path)}/move`, {
				method: "POST",
				headers: { "idempotency-key": args.value.idempotency_key },
				body: JSON.stringify({ to: args.value.to }),
			});
			return toolResult(jsonObject(reply.json));
		}
		if (["write_page", "delete_page", "stage_source", "delete_source"].includes(input.name)) {
			const value = Option.getOrUndefined(decode(FileInput, input.arguments));
			const pages = input.name.endsWith("_page");
			const deleting = input.name.startsWith("delete_");
			const path = (pages ? value?.path.replace(/^\/p\//, "") : value?.path) ?? "";
			const base = value?.base_version;
			if (
				!value ||
				!relative(path) ||
				(base !== undefined && !validVersion(base)) ||
				(deleting
					? value.content !== undefined || typeof base !== "string"
					: value.content === undefined || (!pages && base === undefined))
			)
				return toolError(
					"input_invalid",
					deleting
						? "path and the file's current base_version are required"
						: pages
							? "path and content are required; base_version is the current version, or omitted or null for a new page"
							: "path, content and base_version (from read_source, or null for a new file) are required",
				);
			// App source is only staged through a grant; reload publishes it.
			const target: `/${string}` = `/api/fs/${pages ? "pages" : "app"}/${encoded(path)}`;
			const written = yield* asAgent(
				ctx,
				family,
				`${target}?${pages ? "" : "reload=0&"}baseVersion=${base ?? "null"}`,
				value.content === undefined
					? { method: "DELETE" }
					: { method: "PUT", body: value.content, headers: { "content-type": "text/plain; charset=utf-8" } },
			);
			// read_page has no version, so a stale page write says which version to pass instead.
			if (pages && written.refusal?.code === "stale_base") {
				const current = (yield* asAgent(ctx, family, target)).headers.get(baseVersionHeader);
				return toolError(
					"stale_base",
					written.refusal.message,
					current
						? `The page exists at version ${current}. Read it with read_page, then pass base_version "${current}" to replace it.`
						: "The page does not exist: omit base_version to create it.",
					false,
				);
			}
			const reply = yield* settle(written);
			const batch = jsonObject(reply.json).batch;
			const version = value.content === undefined ? {} : { version: yield* digest(value.content) };
			return toolResult(
				pages
					? deleting
						? { path, deleted: true }
						: { path, url: pageUrl(origin, path), ...version, ...(typeof batch === "string" ? { batch } : {}) }
					: { path, staged: true, ...version },
			);
		}
		if (input.name === "read_source") {
			const args = decode(SourceInput, input.arguments);
			const maxBytes = Option.isSome(args) ? (args.value.max_bytes ?? 200000) : 0;
			if (
				Option.isNone(args) ||
				(args.value.path !== "" && !relative(args.value.path)) ||
				maxBytes < 1 ||
				maxBytes > 1000000
			)
				return toolError("input_invalid", "path must be under app/ (empty for the root) and max_bytes 1–1000000");
			const reply = yield* board(args.value.path === "" ? "/api/fs/app" : `/api/fs/app/${encoded(args.value.path)}`);
			const listing = jsonObject(reply.json).items;
			const version = reply.headers.get(baseVersionHeader);
			if (version === null && Array.isArray(listing)) return toolResult({ path: args.value.path, items: listing });
			const bytes = new TextEncoder().encode(reply.text);
			return toolResult({
				path: args.value.path,
				...(version === null ? {} : { version }),
				// A cut through a multibyte character decodes to a trailing replacement character; drop it.
				content:
					bytes.byteLength > maxBytes
						? new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, "")
						: reply.text,
				truncated: bytes.byteLength > maxBytes,
			});
		}
		if (input.name === "acquire_lock") {
			const args = decode(LockInput, input.arguments);
			if (Option.isNone(args) || (args.value.note?.length ?? 0) > 1000)
				return toolError("input_invalid", "note must be at most 1000 characters");
			const reply = yield* board("/api/lock", { method: "POST", body: JSON.stringify(args.value) });
			return toolResult({ lock: lockView(reply.json) });
		}
		if (input.name === "reload") {
			if (Option.isNone(decode(Empty, input.arguments))) return toolError("input_invalid", "Takes no arguments.");
			// One call and no check=1: boot answers a grant's reload with 202 and finishes after this request drains, and
			// any further grant call here is refused. A rehearsal-only check runs inline for minutes, past client timeouts.
			yield* board("/api/reload", { method: "POST", body: "{}" });
			return toolResult({
				status: "reloading",
				message:
					"The reload started and finishes after this call returns. End this turn; in a later one call reload_status, then release_lock.",
			});
		}
		if (input.name === "reload_status") {
			if (Option.isNone(decode(Empty, input.arguments))) return toolError("input_invalid", "Takes no arguments.");
			const lock = lockView((yield* board("/api/lock")).json);
			const generations =
				Option.getOrUndefined(
					Option.flatMap((yield* board("/api/generations")).json, Schema.decodeUnknownOption(Generations)),
				)?.items ?? [];
			const latest = generations.reduce<(typeof generations)[number] | undefined>(
				(found, item) => (found === undefined || item.n > found.n ? item : found),
				undefined,
			);
			const live = generations.filter((item) => item.status === "live").map((item) => item.n);
			const running = lock?.reload_in_flight === true || latest?.status === "starting";
			return toolResult({
				lock,
				live_generation: live.length > 0 ? Math.max(...live) : null,
				latest: latest
					? {
							n: latest.n,
							status: latest.status,
							error: latest.error === null ? null : cut(latest.error, 2000),
							started_at: latest.started_at,
							healthy_at: latest.healthy_at,
						}
					: null,
				message: running
					? "A reload is still running; check again in a later turn."
					: latest?.status === "failed"
						? "The latest reload failed and the previous generation is still serving. Fix the staged source and reload again, or release_lock to discard it."
						: `Generation ${latest?.n ?? "?"} is ${latest?.status ?? "unknown"}.${lock?.mine ? " You still hold the lock: release_lock when done." : ""}`,
			});
		}
		if (input.name === "release_lock") {
			if (Option.isNone(decode(Empty, input.arguments))) return toolError("input_invalid", "Takes no arguments.");
			yield* board("/api/lock", { method: "DELETE" });
			return toolResult({ released: true });
		}
		return toolError("tool_unknown", `Unknown tool: ${input.name}`);
	}).pipe(Effect.catchTag("Refused", (refused) => Effect.succeed(refused.result)));
