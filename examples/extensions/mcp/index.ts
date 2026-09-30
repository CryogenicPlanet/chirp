import { Effect, Option, Schema, Stream } from "effect";
import type { Api } from "../../../packages/server/src/kernel/extension-api.ts";
import { installEvents } from "./events.ts";
import { installOAuth } from "./oauth.ts";
import { callTool, ToolCall, toolError, tools } from "./tools.ts";

const protocolVersion = "2025-11-25";
const supportedVersions: ReadonlyArray<string> = ["2025-03-26", "2025-06-18", protocolVersion];
/** MCP 2.0: stateless requests that carry their version in `params._meta`; ChatGPT needs it for events. */
const modernVersion = "2026-07-28";
const serverInfo = { name: "chirp", title: "chirp", version: "1.0.0" };
const instructions =
	"Search and fetch before answering from the board. Use post_message only when the user asks you to write.";
const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const boardOrigin = "https://your-board.example";
/**
 * The origin of the `/mcp` URL clients are given; clients send that URL as the OAuth resource, so it must match exactly.
 * Set it to another address of this board to serve MCP there while sign-in, consent and citation links stay on boardOrigin.
 */
const mcpOrigin = boardOrigin;
const validOrigin = (origin: string) => {
	const configured = new URL(origin);
	return (
		origin !== "https://your-board.example" &&
		origin === configured.origin &&
		(configured.protocol === "https:" ||
			(configured.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(configured.hostname)))
	);
};
const RpcMessage = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite, Schema.Null])),
	method: Schema.String,
	params: Schema.optionalKey(Schema.Unknown),
});
const decode = <A>(schema: Schema.ConstraintDecoder<A>, input: unknown) =>
	Schema.decodeOption(schema, { onExcessProperty: "error" })(input);
type RpcId = string | number | null;
const rpc = (id: RpcId, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcId, code: number, message: string, data?: unknown, status = 200) =>
	Response.json(
		{
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data === undefined ? {} : { data }) },
		},
		{ status },
	);
const unauthorized = (origin: string) =>
	Response.json(
		{ error: "invalid_token" },
		{
			status: 401,
			headers: {
				"cache-control": "no-store",
				"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
			},
		},
	);

export default (api: Api) =>
	Effect.gen(function* () {
		const origin = boardOrigin.replace(/\/$/, "");
		const resourceOrigin = mcpOrigin.replace(/\/$/, "");
		if (!validOrigin(origin) || !validOrigin(resourceOrigin))
			return yield* Effect.die("Set boardOrigin and mcpOrigin to this board's exact HTTPS origins before enabling MCP");
		const authenticate = yield* installOAuth(api, origin, resourceOrigin);
		const events = yield* installEvents(api, origin);
		api.route("GET", "/mcp", {
			description: "Decline the optional MCP server event stream because this extension is stateless.",
			access: "application-managed",
			handler: () => Effect.succeed(new Response(null, { status: 405, headers: { allow: "POST" } })),
		});
		api.route("POST", "/mcp", {
			description:
				"OAuth-protected stateless MCP with citation-ready search/fetch, topic reads, and idempotent message posting.",
			access: "application-managed",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					if (
						request.headers.origin !== undefined &&
						request.headers.origin !== origin &&
						request.headers.origin !== resourceOrigin
					)
						return new Response(null, { status: 403 });
					const caller = yield* authenticate(ctx, request.headers.authorization);
					if (!caller) return unauthorized(resourceOrigin);
					const accept = request.headers.accept ?? "";
					if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
						return Response.json(
							{
								error: "Accept must include application/json and text/event-stream",
							},
							{ status: 406 },
						);
					if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json")
						return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
					let bytes = 0;
					const parsed = yield* request.stream.pipe(
						Stream.tap((chunk) =>
							Effect.try(() => {
								bytes += chunk.byteLength;
								if (bytes > 131072) throw new Error("MCP request too large");
							}),
						),
						Stream.runCollect,
						Effect.flatMap((chunks) =>
							Schema.decodeEffect(Schema.fromJsonString(RpcMessage), {
								onExcessProperty: "error",
							})(Buffer.concat(chunks).toString("utf8")),
						),
						Effect.timeout("5 seconds"),
						Effect.result,
					);
					if (parsed._tag === "Failure") return rpcError(null, -32700, "Parse error", undefined, 400);
					const message = parsed.success;
					if (message.id === undefined) return new Response(null, { status: 202 });
					const id = message.id ?? null;
					const runTool = (params: unknown) =>
						Effect.gen(function* () {
							const call = decode(ToolCall, params ?? {});
							if (Option.isNone(call)) return undefined;
							return yield* callTool(ctx, origin, caller, call.value).pipe(
								Effect.catchTag("KernelError", (error) =>
									Effect.succeed(toolError(`Chirp refused the tool call: ${error.code}`)),
								),
							);
						});
					const meta = field(message.params, "_meta");
					const requested = field(meta, "io.modelcontextprotocol/protocolVersion");
					const headerVersion = request.headers["mcp-protocol-version"];
					if (message.method !== "initialize" && (requested !== undefined || headerVersion === modernVersion)) {
						const capabilities = field(meta, "io.modelcontextprotocol/clientCapabilities");
						if (typeof requested !== "string" || typeof capabilities !== "object" || capabilities === null)
							return rpcError(
								id,
								-32602,
								"Invalid params: _meta needs io.modelcontextprotocol/protocolVersion and clientCapabilities",
								undefined,
								400,
							);
						// Standard headers are checked when sent; a present header that disagrees with the body is refused.
						const method = request.headers["mcp-method"];
						const name = request.headers["mcp-name"];
						if (
							(headerVersion !== undefined && headerVersion !== requested) ||
							(method !== undefined && method !== message.method) ||
							(name !== undefined && message.method === "tools/call" && name !== field(message.params, "name"))
						)
							return rpcError(id, -32020, "HeaderMismatch", undefined, 400);
						if (requested !== modernVersion)
							return rpcError(
								id,
								-32022,
								"Unsupported protocol version",
								{ supported: [modernVersion, ...supportedVersions], requested },
								400,
							);
						const complete = (result: object) => rpc(id, { resultType: "complete", ...result });
						if (message.method === "server/discover")
							return complete({
								supportedVersions: [modernVersion],
								capabilities: { tools: {}, events: {} },
								instructions,
								ttlMs: 3600000,
								cacheScope: "public",
								_meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
							});
						if (message.method === "tools/list") return complete({ tools, ttlMs: 3600000, cacheScope: "public" });
						if (message.method === "tools/call") {
							const result = yield* runTool(message.params);
							return result ? complete(result) : rpcError(id, -32602, "Invalid tool call parameters", undefined, 400);
						}
						if (message.method === "events/list") return complete(events.list);
						if (message.method === "events/subscribe" || message.method === "events/unsubscribe") {
							const outcome = yield* (message.method === "events/subscribe" ? events.subscribe : events.unsubscribe)(
								ctx,
								caller,
								message.params,
							);
							return "error" in outcome
								? rpcError(id, outcome.error.code, outcome.error.message, outcome.error.data)
								: complete(outcome.result);
						}
						return rpcError(id, -32601, `Method not found: ${message.method}`, undefined, 404);
					}
					if (message.method === "initialize") {
						const version =
							typeof message.params === "object" && message.params !== null && "protocolVersion" in message.params
								? Reflect.get(message.params, "protocolVersion")
								: undefined;
						return rpc(id, {
							protocolVersion:
								typeof version === "string" && supportedVersions.includes(version) ? version : protocolVersion,
							capabilities: { tools: { listChanged: false } },
							serverInfo,
							instructions,
						});
					}
					if (headerVersion !== undefined && !supportedVersions.includes(headerVersion))
						return rpcError(
							id,
							-32600,
							"Unsupported MCP protocol version",
							{
								supported: supportedVersions,
								requested: headerVersion,
							},
							400,
						);
					if (message.method === "ping") return rpc(id, {});
					if (message.method === "tools/list") return rpc(id, { tools });
					if (message.method === "tools/call") {
						const result = yield* runTool(message.params);
						return result ? rpc(id, result) : rpcError(id, -32602, "Invalid tool call parameters");
					}
					return rpcError(id, -32601, `Method not found: ${message.method}`);
				}),
		});
	});
