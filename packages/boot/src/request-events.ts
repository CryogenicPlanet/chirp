import { Cause, Clock, Duration, Effect, Option, Queue, Ref, Schema, Semaphore } from "effect";
import type { HttpServerResponse } from "effect/unstable/http";
import type { VerifiedIdentity } from "./enrollment.ts";
import type { EventRecord, Events } from "./events.ts";
import { requestQuery } from "./request-query.ts";

type RequestPayload = {
	readonly trace_id: string;
	readonly span_id: string;
	readonly method: string;
	readonly path: string;
	readonly query?: ReadonlyArray<readonly [string, string]>;
	readonly query_truncated?: true;
	readonly user_agent?: string;
	readonly status: number;
	readonly error_code?: string;
	readonly duration_ms: number;
	readonly outcome: "completed" | "failed" | "interrupted";
	readonly lost?: number;
};
// Drops no later request carried, written by boot on their own once the queue drains.
type LostPayload = { readonly outcome: "lost"; readonly lost: number };
type Stored<Payload> = Omit<typeof EventRecord.Type, "seq" | "payload"> & { readonly payload: Payload };
type RequestRecord = Stored<RequestPayload>;
// Missing records per actor: the agent, or `boot` for anonymous and boot-refused requests.
type Counts = ReadonlyMap<string, number>;
const empty = (): Counts => new Map();
const take = (counts: Counts, actor: string): readonly [number, Counts] => {
	const count = counts.get(actor) ?? 0;
	if (count === 0) return [0, counts];
	const rest = new Map(counts);
	rest.delete(actor);
	return [count, rest];
};
const add = (counts: Counts, actor: string, count: number): Counts =>
	count === 0 ? counts : new Map(counts).set(actor, (counts.get(actor) ?? 0) + count);
// Boot's own refusals carry a stable {error:{code}}. Proxied app bodies are streams and are never read.
const BootError = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({ code: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/))) }),
	}),
);
const errorCode = (response: HttpServerResponse.HttpServerResponse) =>
	response.status >= 400 && response.body._tag === "Uint8Array" && response.body.contentLength <= 8192
		? Schema.decodeOption(BootError)(response.body.text ?? new TextDecoder().decode(response.body.body)).pipe(
				Option.map((body) => body.error.code),
				Option.getOrNull,
			)
		: null;

/** Boot-scoped diagnostic writer. Request finalizers never acquire the SQL connection;
 * a blocked store can lose diagnostics, but cannot retain traffic admission. */
export const requestEvents = (events: Events["Service"]) =>
	Effect.gen(function* () {
		const pending = yield* Queue.dropping<RequestRecord>(256);
		// A missing record is counted as `lost` on a later stored record of the same actor, so a reader who sees
		// only one actor's records can still tell a quiet period from lost history. A drop is carried by that
		// actor's next record queued, a failed write by its next record written, and either, once the queue
		// drains, by a `lost` record of its own; refused writes are retried that way until stored, even without
		// further traffic. A request that finished between two stored records of an actor is therefore stored
		// between them or counted by one of them, unless boot stopped with records queued or refused.
		const dropped = yield* Ref.make(empty());
		// Taking the drop count and offering its carrier must not interleave with another finalizer, or a
		// record could be queued without drops that happened before it while the count waits for a later one.
		const handoff = yield* Semaphore.make(1);
		const retry = Duration.seconds(2);
		const failed = yield* Ref.make(empty());
		const withLost = (payload: RequestPayload, count: number): RequestPayload =>
			count === 0 ? payload : { ...payload, lost: (payload.lost ?? 0) + count };
		const write = (event: Stored<RequestPayload | LostPayload>) =>
			Effect.gen(function* () {
				const lost = (event.payload.lost ?? 0) + (yield* Ref.modify(failed, (counts) => take(counts, event.actor)));
				const payload = lost === 0 ? event.payload : { ...event.payload, lost };
				return yield* events.writeBoot({ ...event, payload }).pipe(
					Effect.as(true),
					// Do not retry an uncertain commit or include request/error contents in stderr.
					Effect.catchCauseIf(
						(cause) => !Cause.hasInterruptsOnly(cause),
						() =>
							Ref.update(failed, (counts) =>
								add(counts, event.actor, lost + (payload.outcome === "lost" ? 0 : 1)),
							).pipe(
								// Retried lost records would log once per interval for as long as the store refuses them.
								Effect.andThen(
									payload.outcome === "lost" ? Effect.void : Effect.logError("http.request event write failed"),
								),
								Effect.as(false),
							),
					),
				);
			});
		// A lost record can count requests from several generations, so it names none: generation 0, as for
		// requests boot refuses before selecting one.
		const lostRecord = (actor: string, lost: number) =>
			Clock.currentTimeMillis.pipe(
				Effect.map((at): Stored<LostPayload> => ({
					at,
					type: "http.request",
					level: "warn",
					actor,
					instance: null,
					generation: 0,
					request_id: null,
					topic: null,
					message_id: null,
					payload: { outcome: "lost", lost },
				})),
			);
		yield* Effect.gen(function* () {
			// While refused writes are outstanding, wait for the next record at most one retry interval, then retry
			// them on their own: the refused request may have been the last one, and the store may have recovered.
			const waiting = (yield* Ref.get(failed)).size > 0;
			const next = waiting
				? yield* Queue.take(pending).pipe(Effect.timeoutOption(retry))
				: Option.some(yield* Queue.take(pending));
			const stored = Option.isSome(next) ? yield* write(next.value) : false;
			const drained = yield* handoff.withPermit(
				Queue.size(pending).pipe(
					Effect.flatMap((size) => (size === 0 ? Ref.getAndSet(dropped, empty()) : Effect.succeed(empty()))),
				),
			);
			// Right after a refused write, wait for the retry interval rather than retry at once, so a failing
			// store is asked at most once per interval.
			const refused =
				(stored || Option.isNone(next)) && (yield* Queue.size(pending)) === 0
					? yield* Ref.getAndSet(failed, empty())
					: empty();
			yield* Effect.forEach(
				new Set([...drained.keys(), ...refused.keys()]),
				(actor) => lostRecord(actor, (drained.get(actor) ?? 0) + (refused.get(actor) ?? 0)).pipe(Effect.flatMap(write)),
				{ discard: true },
			);
		}).pipe(Effect.forever, Effect.forkScoped);
		return (input: {
			readonly started: bigint;
			readonly method: string;
			readonly path: string;
			readonly search: string;
			readonly userAgent: string | undefined;
			readonly identity: VerifiedIdentity | null;
			readonly generation: number;
			readonly requestId: string;
		}) =>
			Effect.gen(function* () {
				const span = yield* Effect.makeSpan("http.request", { root: true });
				let status = 503;
				let code: string | null = null;
				let identity = input.identity;
				let generation = input.generation;
				const query = requestQuery(input.search);
				yield* Effect.addFinalizer((exit) =>
					Effect.gen(function* () {
						span.end(yield* Clock.monotonicTimeNanos, exit);
						const interrupted = exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause);
						const record: RequestRecord = {
							at: yield* Clock.currentTimeMillis,
							type: "http.request",
							level: status >= 500 || exit._tag === "Failure" ? "error" : "info",
							actor: identity?.agent ?? "boot",
							instance: identity?.id ?? null,
							generation,
							request_id: input.requestId,
							topic: null,
							message_id: null,
							payload: {
								trace_id: span.traceId,
								span_id: span.spanId,
								method: input.method,
								path: input.path.slice(0, 2048),
								...query,
								...(input.userAgent === undefined ? {} : { user_agent: input.userAgent.slice(0, 256) }),
								status,
								...(code === null ? {} : { error_code: code }),
								duration_ms: Number((yield* Clock.monotonicTimeNanos) - input.started) / 1_000_000,
								outcome: interrupted ? "interrupted" : exit._tag === "Failure" ? "failed" : "completed",
							},
						};
						const queued = yield* handoff.withPermit(
							Effect.gen(function* () {
								const missed = yield* Ref.modify(dropped, (counts) => take(counts, record.actor));
								const offered = yield* Queue.offer(pending, { ...record, payload: withLost(record.payload, missed) });
								if (!offered) yield* Ref.update(dropped, (counts) => add(counts, record.actor, missed + 1));
								return offered;
							}),
						);
						if (!queued) yield* Effect.logError("http.request event queue full");
					}),
				);
				return {
					span,
					trace: `00-${span.traceId}-${span.spanId}-01`,
					attribute: (verified: VerifiedIdentity | null, selectedGeneration: number) =>
						Effect.sync(() => {
							identity = verified;
							generation = selectedGeneration;
						}),
					respond: (response: HttpServerResponse.HttpServerResponse) =>
						Effect.sync(() => {
							status = response.status;
							code = errorCode(response);
						}),
				};
			});
	});
export type RequestEvents = Effect.Success<ReturnType<typeof requestEvents>>;
