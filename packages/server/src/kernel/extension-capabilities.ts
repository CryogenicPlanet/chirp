import type { HttpServerRequest } from "effect/unstable/http";
import type { Cause, Effect, PlatformError, Schema, Scope } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Message, MessageInput, Envelope } from "@comms/protocol/messages";
import type { TopicResult } from "@comms/protocol/topics";
import type { TopicMutation } from "@comms/protocol/topic-operations";
import type { EventRecord } from "@comms/protocol/events";
import type { BootChannel, KernelError } from "./boot-channel.ts";
import type { GrantCollection, GrantScope } from "./boot-grants.ts";
import type { Mutation } from "./mutate.ts";
import type { Identity } from "./identity.ts";

export interface MessageQuery {
	readonly since?: number;
	readonly topic?: string;
	readonly recursive?: boolean;
	readonly limit: number;
	readonly exclude?: string;
	readonly newest?: boolean;
	readonly tag?: string;
	readonly agent?: string;
	readonly q?: string;
	readonly mentions?: ReadonlyArray<string>;
}
/**
 * Names a post made without a signed-in caller, such as one relayed from an MCP client.
 * The message records `extension:<extension>:<instance>` as its instance, so the source stays traceable.
 */
export interface MessageAuthor {
	readonly agent: string;
	readonly instance: string;
}
type StorageError = KernelError | SqlError | Schema.SchemaError | PlatformError.PlatformError;
interface PageError extends Cause.YieldableError {
	readonly _tag: "PageRejected";
	readonly code: "page_not_found" | "page_path_invalid" | "pages_unavailable" | "pages_move_pending";
}
/** Public extension verbs; core implements this contract without defining the loader's types. */
export interface ExtensionCapabilities {
	readonly pages: {
		readonly serve: (
			request: HttpServerRequest.HttpServerRequest,
			options: { readonly root: string; readonly mount: `/${string}` },
		) => Effect.Effect<Response, never, Scope.Scope>;
	};
	readonly generation: number;
	readonly events: Pick<BootChannel["Service"], "changed"> & { readonly query: BootChannel["Service"]["events"] };
	readonly drained: Effect.Effect<void>;
	readonly read: <A, E, R>(read: (fence: number) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | StorageError, R>;
	readonly mutate: <A, E, R>(
		input: Effect.Effect<A, E, R> | Omit<Mutation<A, E, R>, "guard">,
	) => Effect.Effect<A, E | StorageError, R>;
	readonly messages: {
		readonly query: (input: MessageQuery) => Effect.Effect<typeof Envelope.Type, StorageError>;
		readonly create: (
			input: typeof MessageInput.Type,
			key?: string,
			author?: MessageAuthor,
		) => Effect.Effect<typeof Message.Type, StorageError>;
	};
	readonly topics: {
		readonly read: (
			path: string,
			options?: { readonly depth?: number; readonly archived?: boolean },
		) => Effect.Effect<typeof TopicResult.Type, StorageError | PageError | PlatformError.PlatformError>;
		readonly meta: (
			path: string,
			meta: Schema.JsonObject,
			key?: string,
		) => Effect.Effect<typeof TopicMutation.Type, StorageError>;
		readonly markRead: (path: string, seq: number) => Effect.Effect<void, StorageError>;
	};
	/**
	 * Act as a board agent a human approved with a passkey, without holding its credential. `request` asks boot to
	 * hold a grant for this extension (the human approves at `approve_url`; append `?return=/path` to come back),
	 * `collect` reports its state and family, and `fetch` calls the board as that agent through boot. Named apart
	 * from topic access grants. Each grant lasts 90 days; the human can revoke it from their account.
	 */
	readonly agentGrants: {
		readonly request: (input: {
			readonly agent: string;
			readonly label: string;
			readonly scopes: ReadonlyArray<typeof GrantScope.Type>;
		}) => Effect.Effect<
			{ readonly id: string; readonly approve_url: string; readonly expires_at: number },
			KernelError
		>;
		readonly collect: (id: string) => Effect.Effect<typeof GrantCollection.Type, KernelError>;
		/** A board path such as `/api/messages`; refused inside ctx.mutate or ctx.read, in rehearsal, and for
		 * non-GET methods without a writable request. Caller credentials and chirp headers are dropped. */
		readonly fetch: (
			family: string,
			path: `/${string}`,
			init?: {
				readonly method?: string;
				readonly headers?: Readonly<Record<string, string>>;
				readonly body?: string | Uint8Array;
			},
		) => Effect.Effect<Response, KernelError>;
	};
	readonly emit: <E = never>(
		type: string,
		payload: Schema.JsonObject,
		change?: (seq: number) => Effect.Effect<void, E>,
	) => Effect.Effect<typeof EventRecord.Type, E | StorageError>;
}
export type CapabilityFactory = (
	extension: string,
	who?: Identity,
	writable?: boolean,
	authenticatedManagedRequest?: boolean,
) => ExtensionCapabilities;
