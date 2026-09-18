import { Effect, Option, Schema, Stream } from "effect";
import type { Api } from "../../../src/kernel/extension-api.ts";
import { installOAuth } from "./oauth.ts";
import { callTool, ToolCall, toolError, tools } from "./tools.ts";

const protocolVersion = "2025-11-25";
const supportedVersions: ReadonlyArray<string> = ["2025-03-26", "2025-06-18", protocolVersion];
const boardOrigin = "https://your-board.example";
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
				"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"`,
			},
		},
	);

export default (api: Api) =>
	Effect.gen(function* () {
		const origin = boardOrigin.replace(/\/$/, "");
		const configured = new URL(origin);
		if (
			origin === "https://your-board.example" ||
			origin !== configured.origin ||
			(configured.protocol !== "https:" &&
				!(configured.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(configured.hostname)))
		)
			return yield* Effect.die("Set boardOrigin to this board's exact HTTPS origin before enabling MCP");
		const authenticate = yield* installOAuth(api, origin);
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
					if (request.headers.origin !== undefined && request.headers.origin !== origin)
						return new Response(null, { status: 403 });
					const caller = yield* authenticate(ctx, request.headers.authorization);
					if (!caller) return unauthorized(origin);
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
					if (message.method === "initialize") {
						const version =
							typeof message.params === "object" && message.params !== null && "protocolVersion" in message.params
								? Reflect.get(message.params, "protocolVersion")
								: undefined;
						return rpc(id, {
							protocolVersion:
								typeof version === "string" && supportedVersions.includes(version) ? version : protocolVersion,
							capabilities: { tools: { listChanged: false } },
							serverInfo: { name: "chirp", title: "chirp", version: "1.0.0" },
							instructions:
								"Search and fetch before answering from the board. Use post_message only when the user asks you to write.",
						});
					}
					const headerVersion = request.headers["mcp-protocol-version"];
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
						const call = decode(ToolCall, message.params ?? {});
						if (Option.isNone(call)) return rpcError(id, -32602, "Invalid tool call parameters");
						const result = yield* callTool(ctx, origin, caller, call.value).pipe(
							Effect.catchTag("KernelError", (error) =>
								Effect.succeed(toolError(`Chirp refused the tool call: ${error.code}`)),
							),
						);
						return rpc(id, result);
					}
					return rpcError(id, -32601, `Method not found: ${message.method}`);
				}),
		});
	});
