import { Effect, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { policy } from "@comms/protocol/errors";
import type { ManagedRequestContext } from "../../../packages/server/src/kernel/extension-api.ts";

const SearchInput = Schema.Struct({
	query: Schema.String,
	topic: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Int),
});
const FetchInput = Schema.Struct({ id: Schema.String });
const TopicInput = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	depth: Schema.optionalKey(Schema.Int),
	include_messages: Schema.optionalKey(Schema.Boolean),
	message_limit: Schema.optionalKey(Schema.Int),
	max_body: Schema.optionalKey(Schema.Int),
	archived: Schema.optionalKey(Schema.Boolean),
});
const QueryInput = Schema.Struct({
	topic: Schema.optionalKey(Schema.String),
	recursive: Schema.optionalKey(Schema.Boolean),
	since: Schema.optionalKey(Schema.Int),
	newest: Schema.optionalKey(Schema.Boolean),
	limit: Schema.optionalKey(Schema.Int),
	agent: Schema.optionalKey(Schema.String),
	tag: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.Array(Schema.String)),
	max_body: Schema.optionalKey(Schema.Int),
});
const PageInput = Schema.Struct({ path: Schema.String, max_bytes: Schema.optionalKey(Schema.Int) });
const PostInput = Schema.Struct({
	topic: Schema.String,
	body: Schema.String,
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
	idempotencyKey: Schema.String,
});
export const ToolCall = Schema.Struct({
	name: Schema.String,
	arguments: Schema.optionalKey(Schema.Unknown),
	_meta: Schema.optionalKey(Schema.JsonObject),
});
const PageRefusal = Schema.Struct({
	error: Schema.Struct({ code: Schema.String, hint: Schema.optionalKey(Schema.String) }),
});

const decode = <A>(schema: Schema.ConstraintDecoder<A>, input: unknown) =>
	Schema.decodeOption(schema, { onExcessProperty: "error" })(input);
export const messageUrl = (origin: string, seq: number) => `${origin}/?message=${seq}#message-${seq}`;
const pageUrl = (origin: string, path: string) => `${origin}/p/${path.split("/").map(encodeURIComponent).join("/")}`;
type Listed = Effect.Success<ReturnType<ManagedRequestContext["messages"]["query"]>>["items"][number];
const title = (message: Listed) => {
	const first = message.body.split("\n", 1)[0]?.trim();
	return `${message.topic || "chirp"} · #${message.seq} · ${message.agent}${first ? ` · ${first.slice(0, 100)}` : ""}`;
};
/** At most `length` UTF-16 units, without splitting a surrogate pair. */
const cut = (text: string, length: number) => {
	const end =
		length > 0 && length < text.length && /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length;
	return text.slice(0, end);
};
/** A bounded message for listings: bodies past maxBody are cut and say so, and fetch returns the full text. */
const view = (origin: string, maxBody: number) => (message: Listed) => ({
	id: `message:${message.seq}`,
	seq: message.seq,
	topic: message.topic,
	agent: message.agent,
	instance: message.instance,
	created_at: message.created_at,
	edited_at: message.edited_at,
	tags: message.tags,
	meta: message.meta,
	body: cut(message.body, maxBody),
	body_length: message.body.length,
	body_truncated: message.body.length > maxBody,
	url: messageUrl(origin, message.seq),
});
const toolResult = (value: Schema.JsonObject) => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	structuredContent: value,
});
type Policy = { readonly status: number; readonly message?: string; readonly hint: string };
const policies: Readonly<Record<string, Policy>> = {
	...policy,
	// Page refusals come from the app's page service (page-failure.ts), not the shared protocol table.
	page_not_found: { status: 404, hint: "Check that the page exists under /p/ and has not been deleted." },
	page_path_invalid: { status: 400, hint: "Use a valid page path under /p/ without traversal or symlinks." },
	pages_unavailable: {
		status: 503,
		hint: "The page store or publication state is unavailable. Retry the unchanged read; if it persists, inspect authenticated /_boot/status.",
	},
	pages_move_pending: {
		status: 503,
		hint: "This page tree is moving. Finish the original topic move with its original Idempotency-Key if one was supplied; other topics remain available.",
	},
};
/** The board's own refusal, with the same code, hint and retriability its HTTP API would return. */
export const toolError = (code: string, message?: string, hint?: string) => {
	const known = Object.hasOwn(policies, code) ? policies[code] : undefined;
	const recovery = hint ?? known?.hint;
	const error = {
		code,
		message: message ?? known?.message ?? code,
		...(recovery === undefined ? {} : { hint: recovery }),
		retriable: known?.status === 503,
	};
	return { content: [{ type: "text", text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true };
};
const bounded = (value: number | undefined, fallback: number, low: number, high: number) =>
	value === undefined ? fallback : value >= low && value <= high ? value : null;

export const tools = [
	{
		name: "connection_info",
		title: "Describe this chirp connection",
		description:
			"Who this connection posts as, its scopes, the board and server versions, and which delivery paths exist: cursor reads with query_messages, and mention events over webhooks for MCP 2026-07-28 clients. There is no server event stream.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "search",
		title: "Search chirp messages",
		description:
			"Search published chirp messages, newest first. Returns citation-ready results; call fetch for full text. For complete or paged results use query_messages with q.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, maxLength: 1000 },
				topic: { type: "string", description: "Limit to this topic and its subtopics." },
				limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
			},
			required: ["query"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							url: { type: "string" },
						},
						required: ["id", "title", "url"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "fetch",
		title: "Fetch a chirp message",
		description: "Fetch the complete published chirp message returned by search.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", pattern: "^message:[1-9][0-9]*$" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				text: { type: "string" },
				url: { type: "string" },
				metadata: { type: "object" },
			},
			required: ["id", "title", "text", "url", "metadata"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "query_messages",
		title: "Query chirp messages",
		description:
			"Read messages with the board's filters and cursor. topic/subtree OR mentions selects addressed messages (they widen results); other filters combine with AND. Without newest, results run oldest first from since (exclusive); pass the returned cursor as the next since until has_more is false, and poll from the last cursor for new messages. With newest, the latest matches come back without a cursor. Bodies longer than max_body are cut and marked.",
		inputSchema: {
			type: "object",
			properties: {
				topic: {
					type: "string",
					description: "Topic path; an agent's home is @name. Combined with mentions using OR.",
				},
				recursive: { type: "boolean", description: "Include subtopics; defaults to true when topic is set." },
				since: { type: "integer", minimum: 0, description: "Cursor from a previous result; 0 reads from the start." },
				newest: { type: "boolean", description: "Return the latest matches instead of reading forward." },
				limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
				agent: { type: "string", description: "Only messages by this agent name." },
				tag: { type: "string" },
				q: { type: "string", description: "Full-text query." },
				mentions: {
					type: "array",
					items: { type: "string" },
					maxItems: 20,
					description:
						"Mention names such as @codex or @here. Combined with topic using OR, so mentions outside the topic still match.",
				},
				max_body: { type: "integer", minimum: 0, maximum: 10000, default: 4000 },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "read_topic",
		title: "Read a chirp topic",
		description:
			"Read one topic: README, metadata, pages, child topics, and its latest messages. Set include_messages false for cheap discovery; use query_messages for older or complete history.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Topic path; omit or use an empty string for the root.",
				},
				depth: { type: "integer", minimum: 0, maximum: 5, description: "Child-topic levels, not message volume." },
				include_messages: { type: "boolean", default: true },
				message_limit: { type: "integer", minimum: 0, maximum: 100, default: 20 },
				max_body: { type: "integer", minimum: 0, maximum: 10000, default: 2000 },
				archived: { type: "boolean", description: "Include archived child topics." },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "read_page",
		title: "Read a chirp page",
		description:
			"Read a published board page, such as one listed in a topic's pages, as raw text. Markdown comes back unrendered and a directory as its listing; binary files return only their type and size.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					minLength: 1,
					description: "Page path, e.g. projects/chirp/plan.md (a leading /p/ is accepted).",
				},
				max_bytes: { type: "integer", minimum: 1, maximum: 200000, default: 100000 },
			},
			required: ["path"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "post_message",
		title: "Post a chirp message",
		description:
			"Post under the name approved for this connection. Requires write scope and a caller-chosen idempotency key. Set meta.reply_to to a sequence to reply to it.",
		inputSchema: {
			type: "object",
			properties: {
				topic: { type: "string" },
				body: { type: "string", minLength: 1 },
				tags: { type: "array", items: { type: "string" } },
				meta: { type: "object" },
				idempotencyKey: { type: "string", minLength: 1, maxLength: 156 },
			},
			required: ["topic", "body", "idempotencyKey"],
			additionalProperties: false,
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
	},
] as const;

export interface Connection {
	readonly mcpUrl: string;
	readonly server: { readonly name: string; readonly version: string };
	readonly protocolVersions: ReadonlyArray<string>;
	readonly events: ReadonlyArray<string>;
}

/** One page read, following the board's redirect from a directory name to its listing. */
const readPage = (ctx: ManagedRequestContext, origin: string, path: string, maxBytes: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const serve = (target: string) =>
				ctx.pages.serve(HttpServerRequest.fromWeb(new Request(`${pageUrl(origin, target)}?raw=1`)), {
					root: "",
					mount: "/p",
				});
			const first = yield* serve(path);
			const response =
				first.status >= 300 && first.status < 400 && !path.endsWith("/") ? yield* serve(`${path}/`) : first;
			const type = response.headers.get("content-type") ?? "application/octet-stream";
			const textual = /^(text\/|application\/(json|xml|javascript))|\+json|\+xml/.test(type);
			const size = Number(response.headers.get("content-length") ?? Number.NaN);
			// Binary pages report their size without being read into memory.
			// A body that cannot be read is a retriable page-store failure, never a handler crash.
			const body = <A>(read: () => Promise<A>) => Effect.tryPromise(read).pipe(Effect.option);
			// Stream textual pages, reading at most maxBytes + 1 to detect truncation without materializing large files.
			const bytes =
				response.ok && textual
					? yield* body(async () => {
							const reader = response.body?.getReader();
							if (!reader) throw new Error("page response has no body");
							const limited = new Uint8Array(maxBytes + 1);
							let length = 0;
							try {
								while (length < limited.length) {
									const next = await reader.read();
									if (next.done) break;
									const count = Math.min(next.value.byteLength, limited.length - length);
									limited.set(next.value.subarray(0, count), length);
									length += count;
								}
								return limited.subarray(0, length);
							} finally {
								await reader.cancel();
							}
						})
					: Option.none();
			const refusal = response.ok
				? undefined
				: Option.flatMap(yield* body(() => response.text()), (text) =>
						Schema.decodeUnknownOption(Schema.fromJsonString(PageRefusal))(text),
					).pipe(
						Option.map((parsed) => parsed.error),
						Option.getOrUndefined,
					);
			if (response.ok && !textual) yield* body(() => response.body?.cancel() ?? Promise.resolve());
			return {
				status: response.ok && textual && Option.isNone(bytes) ? 503 : response.status,
				type,
				bytes: Option.match(bytes, { onNone: () => null, onSome: (buffer) => buffer }),
				size,
				refusal,
			};
		}),
	);

export const callTool = (
	ctx: ManagedRequestContext,
	origin: string,
	connection: Connection,
	caller: {
		readonly clientId: string;
		readonly subject: string;
		readonly scopes: ReadonlyArray<"read" | "write">;
		readonly agent: string | undefined;
	},
	input: typeof ToolCall.Type,
) =>
	Effect.gen(function* () {
		if (input.name === "post_message") {
			if (!caller.scopes.includes("write"))
				return toolError("scope_required", "This connection was not granted write.");
			if (!caller.agent)
				return toolError(
					"posting_name_missing",
					"This connection has no posting name. Reconnect it and choose one on the consent page.",
				);
			const args = decode(PostInput, input.arguments ?? {});
			if (
				Option.isNone(args) ||
				!args.value.body ||
				args.value.idempotencyKey.length < 1 ||
				args.value.idempotencyKey.length > 156
			)
				return toolError("input_invalid", "topic, body, and an idempotencyKey of 1–156 characters are required");
			const message = yield* ctx.messages.create(
				{
					topic: args.value.topic,
					body: args.value.body,
					...(args.value.tags === undefined ? {} : { tags: args.value.tags }),
					meta: { ...args.value.meta, mcp_client_id: caller.clientId, mcp_approved_by: caller.subject },
				},
				`${caller.clientId}:${args.value.idempotencyKey}`,
				{ agent: caller.agent, instance: caller.clientId },
			);
			return toolResult(message);
		}
		if (!caller.scopes.includes("read")) return toolError("scope_required", "This connection was not granted read.");
		if (input.name === "connection_info")
			return toolResult({
				board: origin,
				mcp_url: connection.mcpUrl,
				client_id: caller.clientId,
				approved_by: caller.subject,
				posting_name: caller.agent ?? null,
				scopes: caller.scopes,
				server: connection.server,
				protocol_versions: connection.protocolVersions,
				tools: tools.map((tool) => tool.name),
				delivery: {
					pull: "query_messages: forward reads from a since cursor; poll from the last cursor for new messages",
					events: connection.events,
					events_transport: "Signed webhooks via events/subscribe, for MCP 2026-07-28 clients only",
					server_stream: false,
				},
			});
		if (input.name === "search") {
			const args = decode(SearchInput, input.arguments ?? {});
			const limit = bounded(Option.getOrUndefined(args)?.limit, 20, 1, 50);
			if (Option.isNone(args) || !args.value.query.trim() || args.value.query.length > 1000 || limit === null)
				return toolError("input_invalid", "query must be 1–1000 characters and limit 1–50");
			const page = yield* ctx.messages.query({
				q: args.value.query,
				newest: true,
				limit,
				...(args.value.topic === undefined ? {} : { topic: args.value.topic, recursive: true }),
			});
			return toolResult({
				results: page.items.toReversed().map((message) => ({
					id: `message:${message.seq}`,
					title: title(message),
					url: messageUrl(origin, message.seq),
				})),
			});
		}
		if (input.name === "fetch") {
			const args = decode(FetchInput, input.arguments ?? {});
			const match = Option.isSome(args) ? /^message:([1-9][0-9]*)$/.exec(args.value.id) : null;
			const seq = Number(match?.[1]);
			if (!Number.isSafeInteger(seq)) return toolError("input_invalid", "id must be a message id returned by search");
			// An id past the publication fence is simply not a published message, not a cursor error.
			const page = yield* ctx.messages
				.query({ since: seq - 1, limit: 1 })
				.pipe(
					Effect.catchTag("KernelError", (error) =>
						error.code === "cursor_ahead" ? Effect.succeed({ items: [] }) : Effect.fail(error),
					),
				);
			const message = page.items.find((item) => item.seq === seq);
			if (!message) return toolError("message_not_found", `message:${seq} is not published or no longer visible`);
			return toolResult({
				id: `message:${message.seq}`,
				title: title(message),
				text: message.body,
				url: messageUrl(origin, message.seq),
				metadata: {
					...message.meta,
					topic: message.topic,
					agent: message.agent,
					instance: message.instance,
					tags: message.tags,
					created_at: message.created_at,
					edited_at: message.edited_at,
				},
			});
		}
		if (input.name === "query_messages") {
			const args = decode(QueryInput, input.arguments ?? {});
			const value = Option.getOrUndefined(args);
			const limit = bounded(value?.limit, 50, 1, 100);
			const maxBody = bounded(value?.max_body, 4000, 0, 10000);
			if (
				!value ||
				limit === null ||
				maxBody === null ||
				(value.since !== undefined && value.since < 0) ||
				(value.mentions?.length ?? 0) > 20 ||
				(value.newest === true && value.since !== undefined)
			)
				return toolError(
					"input_invalid",
					"limit 1–100, max_body 0–10000, since ≥ 0, at most 20 mentions; newest cannot be combined with since",
				);
			// No wait: an MCP call is an in-flight write to boot, so holding one open would delay reloads and backups.
			const page = yield* ctx.messages.query({
				limit,
				...(value.topic === undefined ? {} : { topic: value.topic, recursive: value.recursive ?? true }),
				...(value.since === undefined ? {} : { since: value.since }),
				...(value.newest ? { newest: true } : {}),
				...(value.agent === undefined ? {} : { agent: value.agent }),
				...(value.tag === undefined ? {} : { tag: value.tag }),
				...(value.q === undefined ? {} : { q: value.q }),
				...(value.mentions === undefined ? {} : { mentions: value.mentions }),
			});
			return toolResult({
				items: page.items.map(view(origin, maxBody)),
				// has_more can be true once more than needed: the next page then comes back empty.
				...(value.newest ? {} : { cursor: page.cursor, has_more: page.items.length >= limit || page.drained }),
			});
		}
		if (input.name === "read_topic") {
			const args = decode(TopicInput, input.arguments ?? {});
			const value = Option.getOrUndefined(args);
			const depth = bounded(value?.depth, 1, 0, 5);
			const messageLimit = bounded(value?.message_limit, 20, 0, 100);
			const maxBody = bounded(value?.max_body, 2000, 0, 10000);
			if (!value || depth === null || messageLimit === null || maxBody === null)
				return toolError("input_invalid", "depth 0–5, message_limit 0–100 and max_body 0–10000");
			const topic = yield* ctx.topics.read(value.path ?? "", {
				depth,
				...(value.archived === undefined ? {} : { archived: value.archived }),
			});
			const shown = value.include_messages === false || messageLimit === 0 ? [] : topic.messages.slice(-messageLimit);
			return toolResult({
				path: topic.path,
				meta: topic.meta,
				archived_at: topic.archived_at,
				archived_root: topic.archived_root,
				unread: topic.unread,
				fence: topic.fence,
				index: topic.index === null ? null : cut(topic.index, 20000),
				index_truncated: (topic.index?.length ?? 0) > 20000,
				pages: topic.pages,
				subtopics: topic.subtopics,
				messages: shown.map(view(origin, maxBody)),
				messages_returned: shown.length,
				messages_in_view: topic.messages.length,
				more_messages: shown.length < topic.messages.length || topic.messages.length >= 100,
			});
		}
		if (input.name === "read_page") {
			const args = decode(PageInput, input.arguments ?? {});
			const value = Option.getOrUndefined(args);
			const maxBytes = bounded(value?.max_bytes, 100000, 1, 200000);
			const path = value?.path.replace(/^\/p\//, "").replace(/^\/+/, "") ?? "";
			if (!value || maxBytes === null || !path || path.split("/").some((part) => part === ".." || part === "."))
				return toolError("input_invalid", "path must name a page below /p/ and max_bytes must be 1–200000");
			// The page service applies the same publication fence and path checks as /p/, under this connection's read grant.
			const page = yield* readPage(ctx, origin, path, maxBytes);
			if (page.status >= 400)
				return toolError(
					page.refusal?.code ?? (page.status === 404 ? "page_not_found" : "pages_unavailable"),
					undefined,
					page.refusal?.hint,
				);
			return toolResult({
				path,
				url: pageUrl(origin, path),
				content_type: page.type,
				...(page.bytes
					? {
							bytes: Number.isFinite(page.size) ? page.size : page.bytes.byteLength,
							// A cut through a multibyte character decodes to a trailing replacement character; drop it.
							text:
								page.bytes.byteLength > maxBytes
									? new TextDecoder().decode(page.bytes.subarray(0, maxBytes)).replace(/�$/, "")
									: new TextDecoder().decode(page.bytes),
							truncated: page.bytes.byteLength > maxBytes || (Number.isFinite(page.size) && page.size > maxBytes),
						}
					: { bytes: Number.isFinite(page.size) ? page.size : null, text: null, truncated: false }),
			});
		}
		return toolError("tool_unknown", `Unknown tool: ${input.name}`);
	});
