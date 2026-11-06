import { strict as assert } from "node:assert";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { readTransaction } from "@comms/storage/dialect";
import { testStore } from "./test-store.ts";
import { boardTables, createBoardTables, legacyDetail, legacyPageTopic, seedBoard } from "./topic-read-board.ts";
import { BootChannel } from "../../src/kernel/boot-channel.ts";
import { Pages, layer as pagesLayer } from "../../src/ext/core/pages.ts";
import { makeTopics } from "../../src/ext/core/topics.ts";

const engine = Schema.decodeUnknownSync(Schema.Literals(["sqlite", "pglite", "pg", "mysql"]))(process.argv[2]);
const epoch = "equivalence-epoch";
const board = (seed: number) =>
	Effect.gen(function* () {
		const sql = yield* testStore({
			engine,
			config: process.env.COMMS_TEST_STORE_CONFIG,
			database: "comms_shared_store",
			tables: boardTables,
		});
		yield* createBoardTables(sql, epoch);
		// The scoped root also holds the symlink targets outside the pages directory.
		const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "comms-topic-rollup-" });
		const directory = `${root}/pages`;
		const { ceiling, paths } = yield* seedBoard(sql, { seed, topics: 90, messages: 3000, bodyLength: 40 }, directory);
		const boot: BootChannel["Service"] = {
			epoch,
			generation: 1,
			filename: null,
			store: { _tag: "file", filename: "/unused/equivalence.db" },
			backup: Effect.void,
			fence: Effect.succeed({ published_through: ceiling }),
			changed: () => Effect.never,
			events: () => Effect.die("Topic reads never read events"),
			reserve: () => Effect.die("Topic reads never reserve"),
			append: () => Effect.die("Topic reads never append"),
			abort: () => Effect.void,
		};
		yield* Effect.gen(function* () {
			const pages = yield* Pages;
			const topics = makeTopics(sql, (read) => readTransaction(sql, read(ceiling)), pages);
			const views = [
				"",
				...paths.filter((_, index) => index % 7 === 0),
				"r00/orphan",
				"zz",
				"zz/removed",
				"zz/removed/child",
				"zz/shelved",
				"zz/shelved/inner",
				"r01/fresh",
				"r04/moving",
				"pages-only",
				"pages-only/nested",
				"r00/page-folder",
				"r00/linked",
				"r00/alias",
				"escape",
				"missing/topic",
			];
			const instances = ["root-reader", "nested-reader", "deep-reader", "ahead-reader", "no-marks"];
			let compared = 0;
			for (const path of views)
				for (const depth of [1, 3, 8]) {
					// The snapshot walk must list exactly what the per-entry full-path walk listed.
					assert.deepEqual(
						yield* readTransaction(sql, pages.topic(path, depth)).pipe(
							Effect.catchTag("PageRejected", (error) => Effect.succeed(error.code)),
						),
						yield* readTransaction(sql, legacyPageTopic(pages, path, depth)).pipe(
							Effect.catchTag("PageRejected", (error) => Effect.succeed(error.code)),
						),
						`${engine} seed ${seed} pages ${path || "(root)"} ${depth}`,
					);
					for (const archived of [false, true]) {
						const instance = instances[compared % instances.length] ?? "no-marks";
						const expected = yield* readTransaction(
							sql,
							legacyDetail(sql, pages, ceiling, instance, path, depth, archived),
						).pipe(Effect.catchTag("PageRejected", (error) => Effect.succeed(error.code)));
						const actual = yield* topics
							.detail({ agent: "reader", instance, request: "read", kind: "agent" }, path, depth, archived)
							.pipe(
								Effect.catchTag("KernelError", (error) => Effect.succeed(error.code)),
								Effect.catchTag("PageRejected", (error) => Effect.succeed(error.code)),
							);
						assert.deepEqual(
							actual,
							expected,
							`${engine} seed ${seed} ${instance} ${path || "(root)"} ${depth} ${archived}`,
						);
						compared++;
					}
				}
			// The fixture must exercise every rule, not compare empty views.
			const root = yield* topics.detail(
				{ agent: "reader", instance: "nested-reader", request: "read", kind: "agent" },
				"",
				8,
				true,
			);
			assert.ok(root.unread > 0 && root.subtopics.some((row) => row.archived_at !== null));
			assert.ok(root.subtopics.some((row) => row.unread > 0 && row.unread < row.last_seq));
			// Symlinked folders and files, inside or escaping the root, never become topics or pages.
			const listed = root.subtopics.map((row) => row.path);
			assert.ok(listed.includes("r00/linked"));
			for (const link of ["escape", "r00/alias", "r00/linked/escape"]) assert.ok(!listed.includes(link), link);
			const r00 = yield* topics.detail(
				{ agent: "reader", instance: "nested-reader", request: "read", kind: "agent" },
				"r00",
				1,
				true,
			);
			assert.ok(r00.pages.includes("index.md") && !r00.pages.includes("secret.md"));
			return compared;
		}).pipe(
			Effect.provide(pagesLayer(directory)),
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(BootChannel, boot),
		);
	}).pipe(Effect.scoped);

const main = Effect.gen(function* () {
	for (const seed of [1, 2, 3]) yield* board(seed);
}).pipe(Effect.provide(Layer.merge(BunServices.layer, Reactivity.layer)));
await Effect.runPromise(main);
process.stdout.write("TOPIC_READ_EQUIVALENCE_VERIFIED\n");
