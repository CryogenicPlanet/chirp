import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import type { Api, BackgroundContext, RequestContext } from "../../../src/kernel/extension-api.ts";

// Test-only extension: drives ctx.agentGrants the way an extension such as MCP would.
const Requested = Schema.Struct({
	agent: Schema.String,
	label: Schema.String,
	scopes: Schema.Array(Schema.Literals(["read", "write", "fs"])),
});
const Collect = Schema.Struct({ id: Schema.String });
const Call = Schema.Struct({
	family: Schema.String,
	path: Schema.String,
	method: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.String),
	headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const json = <S extends Schema.Constraint>(request: HttpServerRequest.HttpServerRequest, schema: S) =>
	request.text.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))));
const rooted = (path: string): path is `/${string}` => path.startsWith("/");
const settle = <A extends object>(effect: Effect.Effect<A, unknown>) =>
	effect.pipe(
		Effect.map((value) => Response.json(value)),
		Effect.catch((error) =>
			Effect.succeed(
				Response.json(
					{
						error:
							typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
								? error.code
								: "unexpected",
						detail: typeof error === "object" && error !== null && "detail" in error ? error.detail : null,
					},
					{ status: 418 },
				),
			),
		),
	);
const relay = (ctx: RequestContext, call: typeof Call.Type) =>
	Effect.gen(function* () {
		const response = yield* ctx.agentGrants.fetch(call.family, rooted(call.path) ? call.path : "/", {
			...(call.method === undefined ? {} : { method: call.method }),
			...(call.body === undefined ? {} : { body: call.body }),
			headers: { ...(call.body === undefined ? {} : { "content-type": "application/json" }), ...call.headers },
		});
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: yield* Effect.promise(() => response.text()),
		};
	});
const code = (effect: Effect.Effect<unknown, unknown>) =>
	effect.pipe(
		Effect.as("succeeded"),
		Effect.catch((error) =>
			Effect.succeed(
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: "unexpected",
			),
		),
	);

export default function grantProbe(api: Api) {
	// A rehearsal must never reach boot's grant channel; exiting fails the rehearsal visibly if it does.
	api.on("start", (event: { readonly reason: "live" | "rehearsal" }, ctx: BackgroundContext) =>
		event.reason === "rehearsal"
			? code(ctx.agentGrants.request({ agent: "dot", label: "rehearsal", scopes: ["read"] })).pipe(
					Effect.flatMap((result) =>
						result === "generation_not_live" ? Effect.void : Effect.sync(() => process.exit(97)),
					),
				)
			: undefined,
	);
	api.route("POST", "/api/grant-probe/request", {
		description: "Test probe: request a grant for an agent.",
		scope: "write",
		handler: (request, ctx) =>
			settle(json(request, Requested).pipe(Effect.flatMap((input) => ctx.agentGrants.request(input)))),
	});
	api.route("POST", "/api/grant-probe/collect", {
		description: "Test probe: collect a grant's state.",
		scope: "write",
		handler: (request, ctx) =>
			settle(json(request, Collect).pipe(Effect.flatMap((input) => ctx.agentGrants.collect(input.id)))),
	});
	api.route("POST", "/api/grant-probe/fetch", {
		description: "Test probe: call the board through a grant.",
		scope: "write",
		handler: (request, ctx) => settle(json(request, Call).pipe(Effect.flatMap((call) => relay(ctx, call)))),
	});
	api.route("GET", "/api/grant-probe/fetch", {
		description: "Test probe: read the board through a grant from a read-only request.",
		scope: "read",
		handler: (_request, ctx) =>
			settle(
				relay(ctx, {
					family: String(ctx.query.family ?? ""),
					path: String(ctx.query.path ?? "/"),
					...(ctx.query.method === undefined ? {} : { method: String(ctx.query.method) }),
				}),
			),
	});
	api.route("POST", "/api/grant-probe/refusals", {
		description: "Test probe: calls the kernel must refuse before reaching boot.",
		scope: "write",
		handler: (request, ctx) =>
			settle(
				json(request, Collect).pipe(
					Effect.flatMap(({ id: family }) =>
						Effect.all({
							mutate: code(ctx.mutate(ctx.agentGrants.fetch(family, "/api/messages"))),
							read: code(ctx.read(() => ctx.agentGrants.fetch(family, "/api/messages"))),
							protocolRelative: code(ctx.agentGrants.fetch(family, "//evil.test/api/messages")),
							spaced: code(ctx.agentGrants.fetch(family, "/api/messages?q=a b")),
							backslash: code(ctx.agentGrants.fetch(family, "/\\evil.test")),
							method: code(ctx.agentGrants.fetch(family, "/api/messages", { method: "BREW" })),
						}),
					),
				),
			),
	});
}
