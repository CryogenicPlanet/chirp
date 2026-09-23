import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Console, Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Events, eventsSchema, layer } from "../../src/events.ts";
import { eventFilterSchema, eventRoutingSchema } from "../../src/boot-schema.ts";
import { requestEvents } from "../../src/request-events.ts";

// Request A pauses while its finalizer builds its record. Meanwhile the writer frees one queue slot and request B
// takes it. B must carry the drops that happened before it. Nothing is queued after A is dropped, so once the queue
// drains boot must write A's drop on its own rather than leave it for C.
const Stored = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	outcome: Schema.String,
	lost: Schema.optionalKey(Schema.Int),
});
const stored = Schema.decodeUnknownOption(Stored);
const Result = Schema.fromJsonString(
	Schema.Struct({
		filling: Schema.Int,
		fill: Schema.Int,
		a: Schema.NullOr(Stored),
		b: Schema.NullOr(Stored),
		c: Schema.NullOr(Stored),
		markers: Schema.Array(Stored),
	}),
);
const filling = 300;

const main = Effect.gen(function* () {
	yield* eventsSchema;
	yield* eventRoutingSchema;
	yield* eventFilterSchema;
	return yield* Effect.gen(function* () {
		const events = yield* Events;
		const writes = yield* Queue.unbounded<void>();
		const written = yield* Ref.make<ReadonlyArray<typeof Stored.Type>>([]);
		const observe = yield* requestEvents({
			...events,
			writeBoot: (event) =>
				Queue.take(writes).pipe(
					Effect.andThen(events.writeBoot(event)),
					Effect.tap(() =>
						Ref.update(written, (all) =>
							Option.match(stored(event.payload), { onNone: () => all, onSome: (payload) => [...all, payload] }),
						),
					),
				),
		});
		const request = (path: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					const observed = yield* observe({
						started: yield* Clock.monotonicTimeNanos,
						method: "GET",
						path,
						search: "",
						userAgent: undefined,
						identity: null,
						generation: 1,
						requestId: `request-${path}`,
					});
					yield* observed.respond(HttpServerResponse.empty({ status: 200 }));
				}),
			);
		const settle = Effect.sleep("50 millis");
		// The writer holds one record and the queue holds 256; the rest are dropped.
		yield* Effect.forEach(
			Array.from({ length: filling }, (_, index) => `/fill/${index}`),
			request,
			{ discard: true },
		);
		yield* settle;

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
		const a = yield* request("/a").pipe(Effect.provideService(Clock.Clock, pausing), Effect.forkChild);
		yield* Deferred.await(paused);
		yield* Queue.offer(writes, undefined);
		yield* settle;
		yield* request("/b");
		yield* Deferred.succeed(resume, undefined);
		yield* Fiber.join(a);

		yield* Queue.offerAll(
			writes,
			Array.from({ length: filling * 2 }, () => undefined),
		);
		yield* settle;
		yield* request("/c");
		yield* settle;
		const all = yield* Ref.get(written);
		const find = (path: string) => all.find((payload) => payload.path === path) ?? null;
		yield* Console.log(
			yield* Schema.encodeEffect(Result)({
				filling,
				fill: all.filter((payload) => payload.path?.startsWith("/fill/")).length,
				a: find("/a"),
				b: find("/b"),
				c: find("/c"),
				markers: all.filter((payload) => payload.outcome === "lost"),
			}),
		);
	}).pipe(Effect.provide(layer(Effect.void)));
}).pipe(
	Effect.scoped,
	Effect.provide(Layer.mergeAll(BunServices.layer, SqliteClient.layer({ filename: ":memory:", disableWAL: true }))),
);
main.pipe(BunRuntime.runMain);
