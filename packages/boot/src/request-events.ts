import { Cause, Clock, Effect, Option, Queue, Ref, Schema, Semaphore } from "effect";
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
type RequestRecord = Omit<typeof EventRecord.Type, "seq" | "payload"> & { readonly payload: RequestPayload };
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
		// A missing record is counted as `lost` on a later stored one, so a reader can tell a quiet period
		// from lost history. A drop is carried by the next record queued, and a failed write by the next
		// record written. A request that finished between two stored records is therefore stored between
		// them or counted by one of them, unless boot stopped with records still queued.
		const dropped = yield* Ref.make(0);
		// Taking the drop count and offering its carrier must not interleave with another finalizer, or a
		// record could be queued without drops that happened before it while the count waits for a later one.
		const handoff = yield* Semaphore.make(1);
		const failed = yield* Ref.make(0);
		const withLost = (payload: RequestPayload, count: number): RequestPayload =>
			count === 0 ? payload : { ...payload, lost: (payload.lost ?? 0) + count };
		yield* Effect.gen(function* () {
			const event = yield* Queue.take(pending);
			const payload = withLost(event.payload, yield* Ref.getAndSet(failed, 0));
			yield* events.writeBoot({ ...event, payload }).pipe(
				// Do not retry an uncertain commit or include request/error contents in stderr.
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					() =>
						Ref.update(failed, (count) => count + (payload.lost ?? 0) + 1).pipe(
							Effect.andThen(Effect.logError("http.request event write failed")),
						),
				),
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
								const missed = yield* Ref.getAndSet(dropped, 0);
								const offered = yield* Queue.offer(pending, { ...record, payload: withLost(record.payload, missed) });
								if (!offered) yield* Ref.update(dropped, (count) => count + missed + 1);
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
