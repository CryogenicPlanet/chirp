import { Effect, Option, Schema } from "effect";
import type { ManagedRequestContext } from "../../../packages/server/src/kernel/extension-api.ts";

const SearchInput = Schema.Struct({ query: Schema.String });
const FetchInput = Schema.Struct({ id: Schema.String });
const TopicInput = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	depth: Schema.optionalKey(Schema.Int),
});
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
});

const decode = <A>(schema: Schema.ConstraintDecoder<A>, input: unknown) =>
	Schema.decodeOption(schema, { onExcessProperty: "error" })(input);
const messageUrl = (origin: string, seq: number) => `${origin}/?message=${seq}#message-${seq}`;
const title = (message: {
	readonly seq: number;
	readonly topic: string;
	readonly agent: string;
	readonly body: string;
}) => {
	const first = message.body.split("\n", 1)[0]?.trim();
	return `${message.topic || "chirp"} · #${message.seq} · ${message.agent}${first ? ` · ${first.slice(0, 100)}` : ""}`;
};
const toolResult = (value: Schema.JsonObject) => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	structuredContent: value,
});
export const toolError = (message: string) => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

export const tools = [
	{
		name: "search",
		title: "Search chirp messages",
		description: "Search published chirp messages. Returns citation-ready results; call fetch for full text.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string", minLength: 1, maxLength: 1000 } },
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
		name: "read_topic",
		title: "Read a chirp topic",
		description: "Read one topic with its README, messages, pages, metadata, and child topics.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Topic path; omit or use an empty string for the root.",
				},
				depth: { type: "integer", minimum: 0, maximum: 5 },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "post_message",
		title: "Post a chirp message",
		description: "Post as this MCP extension. Requires write scope and a caller-chosen idempotency key.",
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

export const callTool = (
	ctx: ManagedRequestContext,
	origin: string,
	caller: {
		readonly clientId: string;
		readonly subject: string;
		readonly scopes: ReadonlyArray<"read" | "write">;
	},
	input: typeof ToolCall.Type,
) =>
	Effect.gen(function* () {
		if (input.name === "post_message") {
			if (!caller.scopes.includes("write")) return toolError("Chirp refused the tool call: scope_required");
			const args = decode(PostInput, input.arguments ?? {});
			if (
				Option.isNone(args) ||
				!args.value.body ||
				args.value.idempotencyKey.length < 1 ||
				args.value.idempotencyKey.length > 156
			)
				return toolError("topic, body, and an idempotencyKey of 1–156 characters are required");
			const message = yield* ctx.messages.create(
				{
					topic: args.value.topic,
					body: args.value.body,
					...(args.value.tags === undefined ? {} : { tags: args.value.tags }),
					meta: { ...args.value.meta, mcp_client_id: caller.clientId, mcp_approved_by: caller.subject },
				},
				`${caller.clientId}:${args.value.idempotencyKey}`,
			);
			return toolResult(message);
		}
		if (!caller.scopes.includes("read")) return toolError("Chirp refused the tool call: scope_required");
		if (input.name === "search") {
			const args = decode(SearchInput, input.arguments ?? {});
			if (Option.isNone(args) || !args.value.query.trim() || args.value.query.length > 1000)
				return toolError("query must be a non-empty string of at most 1000 characters");
			const page = yield* ctx.messages.query({
				q: args.value.query,
				newest: true,
				limit: 20,
			});
			return toolResult({
				results: page.items.map((message) => ({
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
			if (!Number.isSafeInteger(seq)) return toolError("id must be a message id returned by search");
			const page = yield* ctx.messages.query({ since: seq - 1, limit: 1 });
			const message = page.items.find((item) => item.seq === seq);
			if (!message) return toolError(`message:${seq} is not published or no longer visible`);
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
		if (input.name === "read_topic") {
			const args = decode(TopicInput, input.arguments ?? {});
			if (Option.isNone(args) || (args.value.depth !== undefined && (args.value.depth < 0 || args.value.depth > 5)))
				return toolError("path must be a string and depth must be an integer from 0 to 5");
			return toolResult(
				yield* ctx.topics.read(args.value.path ?? "", {
					depth: args.value.depth ?? 1,
				}),
			);
		}
		return toolError(`Unknown tool: ${input.name}`);
	});
