import { HttpServerResponse } from "effect/unstable/http";
import { servePage } from "../../page-serving.ts";
import { mysqlSearchConfig } from "./mysql-search-config.ts";
import type { ExtensionCapabilities, MessageAuthor } from "../../kernel/extension-capabilities.ts";
import { markRead } from "./read-marks.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Pages } from "./pages.ts";
import type { Mutation } from "../../kernel/mutate.ts";
import { Publication } from "../../kernel/publication.ts";
import { Crypto, Deferred, Effect, FileSystem, Option, Ref, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel, KernelError } from "../../kernel/boot-channel.ts";
import { MessageInput } from "@comms/protocol/messages";
import { makeMessages, topicPathDetail, validTopic } from "./messages.ts";
import type { Identity } from "../../kernel/identity.ts";
import { HealthProbe } from "../../kernel/health-probe.ts";
import { Lifecycle, RequestMutation } from "../../kernel/lifecycle.ts";
import { makeTopics } from "./topics.ts";

// Mirrors boot's enrollment rule: boot reserves the human owner (packages/boot/src/human-agent.ts) and itself.
const authorName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const reservedAuthors: ReadonlyArray<string> = ["system", "boot", "rahul"];
const authorInstance = /^[A-Za-z0-9._-]{1,128}$/;

/** Bind product operations to the caller; persistence stays in the shared mutation service. */
export const extensionCapabilities = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const boot = yield* BootChannel;
	const publication = yield* Publication;
	const pages = yield* Pages;
	const fs = yield* FileSystem.FileSystem;
	const crypto = yield* Crypto.Crypto;
	const lifecycle = yield* Lifecycle;
	const mysql = yield* mysqlSearchConfig(sql);
	return (
		extension: string,
		who?: Identity,
		writable = true,
		authenticatedManagedRequest = false,
	): ExtensionCapabilities => {
		const caller = who ?? { agent: "system", instance: `extension:${extension}`, request: "", kind: "agent" };
		const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				if (!writable) return yield* new KernelError({ code: "scope_required" });
				// Guarded readiness owns the rollback-only transaction; the shared mutation protocol recognizes this probe.
				if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return yield* effect;
				const admitted = Option.getOrNull(yield* Effect.serviceOption(RequestMutation));
				if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
					return yield* new KernelError({ code: "input_invalid" });
				yield* Effect.acquireRelease(
					lifecycle.gate.withPermit(
						Effect.gen(function* () {
							const state = yield* Ref.get(lifecycle.state);
							if (state !== "live" && !(who && state === "accepted") && !(admitted && (yield* Ref.get(admitted))))
								return yield* new KernelError({ code: "generation_not_live" });
							yield* Ref.update(lifecycle.mutations, (count) => count + 1);
						}),
					),
					() => Ref.update(lifecycle.mutations, (count) => count - 1).pipe(Effect.andThen(lifecycle.activityChanged)),
				);
				return yield* effect;
			}).pipe(Effect.scoped, Effect.provideService(Lifecycle, lifecycle));

		const read = <A, E, R>(
			read: (fence: number) => Effect.Effect<A, E, R>,
		): Effect.Effect<A, E | KernelError | SqlError | Schema.SchemaError, R> =>
			publication.read(read).pipe(Effect.provideService(Lifecycle, lifecycle));
		const mutateAs =
			(actor: Identity) =>
			<A, E, R>(input: Effect.Effect<A, E, R> | Omit<Mutation<A, E, R>, "guard">) =>
				write(
					Effect.gen(function* () {
						if (Effect.isEffect(input)) return yield* publication.change(input);
						if ("guard" in input) return yield* new KernelError({ code: "input_invalid" });
						if (
							input.idempotency &&
							(input.idempotency.instance !== actor.instance || input.idempotency.scope !== undefined)
						)
							return yield* new KernelError({ code: "input_invalid" });
						return yield* publication.mutate({
							...(input.idempotency ? { idempotency: input.idempotency } : {}),
							body: (reserve) =>
								input
									.body(reserve)
									.pipe(
										Effect.flatMap((result) =>
											result.events.some(
												(event) =>
													event.actor !== actor.agent ||
													event.instance !== actor.instance ||
													event.request_id !== actor.request ||
													event.generation !== boot.generation,
											)
												? Effect.fail(new KernelError({ code: "input_invalid" }))
												: Effect.succeed(result),
										),
									),
						});
					}),
				);
		const mutate = mutateAs(caller);
		const messages = makeMessages(sql, { read, mutate }, boot, crypto, mysql);
		const createAs = (input: typeof MessageInput.Type, key: string | undefined, author: MessageAuthor) => {
			// A signed-in caller already names the author; only system-authority contexts may attribute a post.
			if (
				who ||
				authenticatedManagedRequest ||
				reservedAuthors.includes(author.agent) ||
				!authorName.test(author.agent) ||
				!authorInstance.test(author.instance)
			)
				return Effect.fail(
					new KernelError({
						code: "input_invalid",
						detail: {
							field: "author",
							hint: "Name an author only without a signed-in caller, using an unreserved lowercase agent name of at most 64 characters.",
						},
					}),
				);
			const composed = `extension:${extension}:${author.instance}`;
			if (composed.length > 256)
				return Effect.fail(
					new KernelError({
						code: "input_invalid",
						detail: {
							field: "author",
							hint: `The composed instance extension:${extension}:${author.instance} exceeds the 256-character storage limit.`,
						},
					}),
				);
			const actor = {
				agent: author.agent,
				instance: composed,
				request: "",
				kind: "agent",
			} satisfies Identity;
			return Effect.gen(function* () {
				const normalized = { topic: input.topic, body: input.body, tags: input.tags ?? [], meta: input.meta ?? {} };
				const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(MessageInput))(normalized);
				const inputWithAuthor = JSON.stringify({ input: encoded, agent: author.agent });
				return yield* makeMessages(sql, { read, mutate: mutateAs(actor) }, boot, crypto, mysql).create(
					actor,
					input,
					key,
					inputWithAuthor,
				);
			});
		};
		const topics = makeTopics(sql, read, pages);
		return {
			pages: {
				serve: (request, options) =>
					servePage(request, options, pages, read, fs).pipe(Effect.map(HttpServerResponse.toWeb)),
			},
			generation: boot.generation,
			events: { query: boot.events, changed: boot.changed },
			drained: Deferred.await(lifecycle.drained),
			mutate,
			read,
			messages: {
				query: (input: Parameters<typeof messages.list>[0]) =>
					messages.list(input).pipe(Effect.provideService(Lifecycle, lifecycle)),
				create: (input: typeof MessageInput.Type, key?: string, author?: MessageAuthor) =>
					author ? createAs(input, key, author) : messages.create(caller, input, key),
			},
			topics: {
				read: (path: string, options: { readonly depth?: number; readonly archived?: boolean } = {}) =>
					topics
						.detail(caller, path, options.depth, options.archived)
						.pipe(Effect.provideService(Lifecycle, lifecycle)),
				meta: (path: string, meta: Schema.JsonObject, key?: string) => messages.topic(caller, path, { meta }, key),
				// Viewing with read scope may mark only this context's instance, and never an unpublished sequence.
				markRead: (path: string, seq: number) =>
					lifecycle.gate
						.withPermit(
							Effect.gen(function* () {
								if (path === "") return;
								const state = yield* Ref.get(lifecycle.state);
								if (state !== "live" && state !== "accepted") return;
								if (!validTopic(path))
									return yield* new KernelError({ code: "input_invalid", detail: topicPathDetail("path") });
								if (!Number.isSafeInteger(seq) || seq < 0)
									return yield* new KernelError({
										code: "input_invalid",
										detail: {
											field: "seq",
											hint: "seq must be a nonnegative integer no higher than the publication fence.",
										},
									});
								if (seq > (yield* publication.fence).published_through)
									return yield* new KernelError({ code: "cursor_ahead" });
								yield* markRead(sql, publication.mutate, caller, { topic: path, seq });
							}),
						)
						.pipe(Effect.provideService(Lifecycle, lifecycle)),
			},
			emit: <E = never>(type: string, payload: Schema.JsonObject, change?: (seq: number) => Effect.Effect<void, E>) =>
				write(
					Effect.gen(function* () {
						const transaction = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
						return yield* publication
							.recordEvent(
								{
									transaction,
									type,
									level: "info",
									payload,
									actor: caller.agent,
									instance: caller.instance,
									request: caller.request,
								},
								change,
							)
							.pipe(Effect.provideService(Lifecycle, lifecycle), Effect.provideService(Crypto.Crypto, crypto));
					}),
				),
		};
	};
});
