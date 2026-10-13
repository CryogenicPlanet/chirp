import { grantExtensionHeader, grantHeader } from "@comms/protocol/headers";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import { KernelError } from "./boot-channel.ts";

export const GrantScope = Schema.Literals(["read", "write", "fs"]);
export interface GrantRequest {
	readonly extension: string;
	readonly agent: string;
	readonly label: string;
	readonly scopes: ReadonlyArray<typeof GrantScope.Type>;
}
export const GrantCreated = Schema.Struct({ id: Schema.String, approve_url: Schema.String, expires_at: Schema.Int });
/** Collection never carries a credential: boot holds the grant and the app only names its family. */
export const GrantCollection = Schema.Union([
	Schema.Struct({ status: Schema.Literal("pending"), expires_at: Schema.Int }),
	Schema.Struct({
		status: Schema.Literals(["denied", "expired", "revoked"]),
		family: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		status: Schema.Literal("approved"),
		family: Schema.String,
		agent: Schema.String,
		label: Schema.String,
		scopes: Schema.Array(GrantScope),
		expires_at: Schema.Int,
	}),
]);
export interface GrantFetch {
	readonly method: HttpMethod;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: Uint8Array;
}
export interface Grants {
	readonly request: (input: GrantRequest) => Effect.Effect<typeof GrantCreated.Type, KernelError>;
	readonly collect: (id: string, extension: string) => Effect.Effect<typeof GrantCollection.Type, KernelError>;
	readonly fetch: (
		family: string,
		extension: string,
		path: string,
		init: GrantFetch,
	) => Effect.Effect<Response, KernelError>;
}
const Refusal = Schema.Struct({ error: Schema.Struct({ code: Schema.String, hint: Schema.String }) });
// Boot's own wire framing; the decoded body is what the extension receives.
const framing: ReadonlyArray<string> = ["content-encoding", "content-length", "transfer-encoding", "set-cookie"];

/** Grants act only for the live generation; a rehearsal or a standalone kernel has no boot channel. */
export const unavailable: Grants = {
	request: () => Effect.fail(new KernelError({ code: "generation_not_live" })),
	collect: () => Effect.fail(new KernelError({ code: "generation_not_live" })),
	fetch: () => Effect.fail(new KernelError({ code: "generation_not_live" })),
};

const make = Effect.gen(function* () {
	if ((yield* Config.String("STATE").pipe(Config.withDefault("candidate"))) === "rehearsal") return unavailable;
	const url = yield* Config.String("BOOT_URL");
	const secret = yield* Config.Redacted("BOOT_SECRET");
	const client = yield* HttpClient.HttpClient;
	const call = <S extends Schema.Constraint>(path: string, payload: Schema.Json, schema: S, field: string) =>
		Effect.gen(function* () {
			const response = yield* client.execute(
				HttpClientRequest.post(`${url}${path}`).pipe(
					HttpClientRequest.bodyJsonUnsafe(payload),
					HttpClientRequest.setHeader("x-boot-secret", Redacted.value(secret)),
				),
			);
			if (response.status === 200) return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
			const refusal = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Refusal)), Effect.option);
			if (response.status === 400 || response.status === 404)
				return yield* new KernelError({
					code: "input_invalid",
					detail: {
						field,
						hint: refusal._tag === "Some" ? refusal.value.error.hint : "Correct the grant request and retry.",
					},
				});
			// Boot admits grant calls only from the live generation on its loopback channel.
			if (response.status === 403) return yield* new KernelError({ code: "generation_not_live" });
			return yield* new KernelError({ code: "boot_unavailable" });
		}).pipe(
			Effect.timeout("5 seconds"),
			Effect.mapError((error) =>
				Schema.is(KernelError)(error) ? error : new KernelError({ code: "boot_unavailable" }),
			),
		);
	return {
		request: (input) =>
			call(
				"/_boot/grants",
				{ extension: input.extension, agent: input.agent, label: input.label, scopes: [...input.scopes] },
				GrantCreated,
				"grant",
			),
		collect: (id, extension) => call(`/_boot/grants/${encodeURIComponent(id)}`, { extension }, GrantCollection, "id"),
		// Buffered, so one deadline covers the body; boot answers a detached reload with 202 at once.
		fetch: (family, extension, path, init) =>
			Effect.gen(function* () {
				const outgoing = HttpClientRequest.make(init.method)(`${url}${path}`, {
					headers: {
						...init.headers,
						"x-boot-secret": Redacted.value(secret),
						[grantHeader]: family,
						[grantExtensionHeader]: extension,
					},
				});
				const response = yield* client
					.execute(
						init.body === undefined
							? outgoing
							: outgoing.pipe(HttpClientRequest.bodyUint8Array(init.body, init.headers["content-type"])),
					)
					// A followed redirect would replay the grant to another path; the extension sees it instead.
					.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
				const bytes = yield* response.arrayBuffer;
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers))
					if (!framing.includes(name)) headers.set(name, value);
				return new Response([101, 204, 205, 304].includes(response.status) ? null : bytes, {
					status: response.status,
					headers,
				});
			}).pipe(
				Effect.timeout("60 seconds"),
				Effect.mapError(() => new KernelError({ code: "boot_unavailable" })),
			),
	} satisfies Grants;
});

/** Boot's private grant calls, beside the sequence channel: the app names a grant and never holds its credential. */
export class BootGrants extends Context.Service<BootGrants, Grants>()("comms/server/BootGrants") {}
export const layer = Layer.effect(BootGrants, make);
export const unavailableLayer = Layer.succeed(BootGrants, unavailable);
