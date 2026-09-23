import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { VerifiedIdentity } from "../../src/enrollment.ts";
import { Events, eventsSchema, layer } from "../../src/events.ts";
import { eventFilterSchema, eventRoutingSchema } from "../../src/boot-schema.ts";
import { requestEvents } from "../../src/request-events.ts";

const Stored = Schema.Struct({
	actor: Schema.String,
	generation: Schema.Int,
	path: Schema.optionalKey(Schema.String),
	outcome: Schema.String,
	lost: Schema.optionalKey(Schema.Int),
});
const Payload = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	outcome: Schema.String,
	lost: Schema.optionalKey(Schema.Int),
});
const payload = Schema.decodeUnknownOption(Payload);
const Record = Schema.NullOr(Stored);
const Result = Schema.fromJsonString(
	Schema.Struct({
		filling: Schema.Int,
		handoff: Schema.Struct({ fill: Schema.Int, a: Record, b: Record, c: Record, markers: Schema.Array(Stored) }),
		actors: Schema.Struct({ fill: Schema.Int, x: Record, y: Record, markers: Schema.Array(Stored) }),
		refused: Schema.Struct({ x: Record, y: Record, markers: Schema.Array(Stored) }),
	}),
);
const filling = 300;
const agent = (name: string): VerifiedIdentity => ({
	id: `${name}-instance`,
	agent: name,
	kind: "agent",
	label: "test",
	scopes: ["read"],
	expiresAt: Number.MAX_SAFE_INTEGER,
});
// Wait for an exact writer state rather than a fixed delay, which a loaded runner can outlast.
const until = (check: Effect.Effect<boolean>): Effect.Effect<void> =>
	check.pipe(
		Effect.flatMap((done) =>
			done ? Effect.void : Effect.sleep("5 millis").pipe(Effect.andThen(Effect.suspend(() => until(check)))),
		),
	);

const main = Effect.gen(function* () {
	yield* eventsSchema;
	yield* eventRoutingSchema;
	yield* eventFilterSchema;
	return yield* Effect.gen(function* () {
		const events = yield* Events;
		// Each writer takes one token per write, so the test decides when the queue drains. `taken` counts the
		// records the writer has taken from the queue: each one enters writeBoot before waiting for a token.
		const writer = Effect.gen(function* () {
			const writes = yield* Queue.unbounded<void>();
			const taken = yield* Ref.make(0);
			const written = yield* Ref.make<ReadonlyArray<typeof Stored.Type>>([]);
			const refusing = yield* Ref.make(false);
			const refusals = yield* Ref.make(0);
			const observe = yield* requestEvents({
				...events,
				writeBoot: (event) =>
					Ref.update(taken, (count) => count + 1).pipe(
						Effect.andThen(Queue.take(writes)),
						Effect.andThen(Ref.get(refusing)),
						Effect.andThen((refuse) =>
							refuse
								? Ref.update(refusals, (count) => count + 1).pipe(Effect.andThen(Effect.die("store refused")))
								: events.writeBoot(event),
						),
						Effect.tap(() =>
							Ref.update(written, (all) =>
								Option.match(payload(event.payload), {
									onNone: () => all,
									onSome: (stored) => [...all, { actor: event.actor, generation: event.generation, ...stored }],
								}),
							),
						),
					),
			});
			const request = (path: string, identity: VerifiedIdentity | null = null, generation = 1) =>
				Effect.scoped(
					Effect.gen(function* () {
						const observed = yield* observe({
							started: yield* Clock.monotonicTimeNanos,
							method: "GET",
							path,
							search: "",
							userAgent: undefined,
							identity,
							generation,
							requestId: `request-${path}`,
						});
						yield* observed.respond(HttpServerResponse.empty({ status: 200 }));
					}),
				);
			const takenReaches = (count: number) => until(Ref.get(taken).pipe(Effect.map((now) => now >= count)));
			const writtenHas = (found: (all: ReadonlyArray<typeof Stored.Type>) => boolean) =>
				until(Ref.get(written).pipe(Effect.map(found)));
			// The writer holds the first record and the queue holds the next 256; the rest are dropped.
			const fill = (prefix: string) =>
				request(`${prefix}/0`).pipe(
					Effect.andThen(takenReaches(1)),
					Effect.andThen(
						Effect.forEach(
							Array.from({ length: filling - 1 }, (_, index) => `${prefix}/${index + 1}`),
							(path) => request(path),
							{ discard: true },
						),
					),
				);
			// One write frees one queue slot once the writer has taken the next record.
			const freeSlot = Ref.get(taken).pipe(
				Effect.tap(() => Queue.offer(writes, undefined)),
				Effect.flatMap((before) => takenReaches(before + 1)),
			);
			const drain = Queue.offerAll(
				writes,
				Array.from({ length: filling * 2 }, () => undefined),
			);
			const report = (prefix: string, paths: ReadonlyArray<string>) =>
				Ref.get(written).pipe(
					Effect.map((all) => ({
						fill: all.filter((stored) => stored.path?.startsWith(`${prefix}/`)).length,
						found: paths.map((path) => all.find((stored) => stored.path === path) ?? null),
						markers: all.filter((stored) => stored.outcome === "lost"),
					})),
				);
			return { request, fill, freeSlot, drain, writtenHas, report, refusing, refusals };
		});
		const markers = (count: number) => (all: ReadonlyArray<typeof Stored.Type>) =>
			all.filter((stored) => stored.outcome === "lost").length >= count;
		const has = (path: string) => (all: ReadonlyArray<typeof Stored.Type>) =>
			all.some((stored) => stored.path === path);

		// Request A, from a newer generation, pauses while its finalizer builds its record. Meanwhile the writer
		// frees one queue slot and request B takes it. B must carry the drops before it. Nothing is queued after
		// A is dropped, so once the queue drains boot writes A's drop on its own rather than leave it for C, and
		// that record names no generation rather than the generation of the record the writer took last.
		const first = yield* writer;
		yield* first.fill("/fill");
		const clock = yield* Clock.Clock;
		const armed = yield* Ref.make(true);
		const paused = yield* Deferred.make<void>();
		const resume = yield* Deferred.make<void>();
		const pausing: Clock.Clock = {
			currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
			currentTimeMillis: Ref.getAndSet(armed, false).pipe(
				Effect.andThen((pause) =>
					pause ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume))) : Effect.void,
				),
				Effect.andThen(clock.currentTimeMillis),
			),
			currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
			currentTimeNanos: clock.currentTimeNanos,
			monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
			monotonicTimeNanos: clock.monotonicTimeNanos,
			sleep: (duration) => clock.sleep(duration),
		};
		const a = yield* first.request("/a", null, 2).pipe(Effect.provideService(Clock.Clock, pausing), Effect.forkChild);
		yield* Deferred.await(paused);
		yield* first.freeSlot;
		yield* first.request("/b");
		yield* Deferred.succeed(resume, undefined);
		yield* Fiber.join(a);
		yield* first.drain;
		yield* first.writtenHas(markers(1));
		yield* first.request("/c");
		yield* first.writtenHas(has("/c"));
		const handoff = yield* first.report("/fill", ["/a", "/b", "/c"]);

		// Losses are counted per actor: agent x's next record carries only x's drops, agent y's carries none,
		// and the anonymous drops reach a `boot` record once the queue drains.
		const second = yield* writer;
		yield* second.fill("/fill");
		yield* second.request("/x/dropped/0", agent("x"));
		yield* second.request("/x/dropped/1", agent("x"));
		yield* second.freeSlot;
		yield* second.request("/x/carry", agent("x"));
		yield* second.freeSlot;
		yield* second.request("/y/clean", agent("y"));
		yield* second.drain;
		yield* second.writtenHas(markers(1));
		const actors = yield* second.report("/fill", ["/x/carry", "/y/clean"]);

		// A refused write for x returns as an x record once a later write succeeds, not on y's record.
		yield* Ref.set(second.refusing, true);
		yield* second.request("/x/refused", agent("x"));
		yield* until(Ref.get(second.refusals).pipe(Effect.map((count) => count === 1)));
		yield* Ref.set(second.refusing, false);
		yield* second.request("/y/after", agent("y"));
		yield* second.writtenHas(markers(2));
		const refused = yield* second.report("/fill", ["/x/refused", "/y/after"]);

		yield* Console.log(
			yield* Schema.encodeEffect(Result)({
				filling,
				handoff: {
					fill: handoff.fill,
					a: handoff.found[0] ?? null,
					b: handoff.found[1] ?? null,
					c: handoff.found[2] ?? null,
					markers: handoff.markers,
				},
				actors: {
					fill: actors.fill,
					x: actors.found[0] ?? null,
					y: actors.found[1] ?? null,
					markers: actors.markers,
				},
				refused: {
					x: refused.found[0] ?? null,
					y: refused.found[1] ?? null,
					markers: refused.markers.slice(actors.markers.length),
				},
			}),
		);
	}).pipe(Effect.provide(layer(Effect.void)), Effect.timeout("20 seconds"));
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, SqliteClient.layer({ filename: ":memory:", disableWAL: true }))),
);
main.pipe(BunRuntime.runMain);
