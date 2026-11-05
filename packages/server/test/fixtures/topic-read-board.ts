import { isDescendant, on } from "@comms/storage/dialect";
import { TopicSummary } from "@comms/protocol/topics";
import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { StoredMessage, validTopic } from "../../src/ext/core/messages.ts";
import type { PageRejected, Pages } from "../../src/ext/core/pages.ts";
import { publishedMessages } from "../../src/ext/core/published-messages.ts";
import { publishedTopics } from "../../src/ext/core/published-topics.ts";

/** Deterministic board for comparing topic reads: nested, archived, deleted, edited and unpublished rows. */
export const boardTables = ["topics", "messages", "reads", "kernel_writer", "outbox", "topic_page_continuations"];

const random = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

export const createBoardTables = (sql: SqlClient, epoch: string) =>
	Effect.gen(function* () {
		yield* sql`CREATE TABLE kernel_writer(singleton INTEGER PRIMARY KEY,epoch VARCHAR(64) NOT NULL)`;
		yield* sql`INSERT INTO kernel_writer VALUES(1,${epoch})`;
		yield* sql`CREATE TABLE outbox(seq BIGINT PRIMARY KEY,transaction_id TEXT,event TEXT NOT NULL,shipped_at BIGINT)`;
		yield* sql`CREATE TABLE topic_page_continuations(seq BIGINT PRIMARY KEY,from_path TEXT NOT NULL,to_path TEXT NOT NULL,marker TEXT NOT NULL,completed SMALLINT NOT NULL)`;
		yield* on(sql, {
			sqlite: () =>
				Effect.gen(function* () {
					yield* sql`CREATE TABLE topics(path TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,meta TEXT NOT NULL,last_seq INTEGER NOT NULL,created_at INTEGER NOT NULL,archived_at INTEGER,updated_seq INTEGER NOT NULL DEFAULT 0,previous TEXT,deleted_at INTEGER)`;
					yield* sql`CREATE TABLE messages(id TEXT PRIMARY KEY,seq INTEGER NOT NULL UNIQUE,topic TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,meta TEXT NOT NULL,created_at INTEGER NOT NULL,edited_at INTEGER,deleted_at INTEGER,updated_seq INTEGER NOT NULL DEFAULT 0,previous TEXT,mentions TEXT NOT NULL DEFAULT '[]',previous_mentions TEXT NOT NULL DEFAULT '[]')`;
					yield* sql`CREATE TABLE reads(instance TEXT NOT NULL,topic TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(instance,topic))`;
				}),
			pg: () =>
				Effect.gen(function* () {
					yield* sql`CREATE TABLE topics(path TEXT PRIMARY KEY,parent TEXT,name TEXT NOT NULL,meta JSONB NOT NULL,last_seq BIGINT NOT NULL,created_at BIGINT NOT NULL,archived_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous TEXT,deleted_at BIGINT)`;
					yield* sql`CREATE TABLE messages(id TEXT PRIMARY KEY,seq BIGINT NOT NULL,topic TEXT NOT NULL,agent TEXT NOT NULL,instance TEXT NOT NULL,body TEXT NOT NULL,tags JSONB NOT NULL,meta JSONB NOT NULL,created_at BIGINT NOT NULL,edited_at BIGINT,deleted_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous TEXT,mentions TEXT NOT NULL DEFAULT '[]',previous_mentions TEXT NOT NULL DEFAULT '[]',body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',coalesce(body,''))) STORED)`;
					yield* sql`CREATE UNIQUE INDEX messages_seq ON messages(seq)`;
					yield* sql`CREATE TABLE reads(instance TEXT NOT NULL,topic TEXT NOT NULL,seq BIGINT NOT NULL,PRIMARY KEY(instance,topic))`;
				}),
			mysql: () =>
				Effect.gen(function* () {
					yield* sql`CREATE TABLE topics(path VARCHAR(256) PRIMARY KEY,parent VARCHAR(256),name LONGTEXT NOT NULL,meta JSON NOT NULL,last_seq BIGINT NOT NULL,created_at BIGINT NOT NULL,archived_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous LONGTEXT,deleted_at BIGINT) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
					yield* sql`CREATE TABLE messages(id VARCHAR(256) PRIMARY KEY,seq BIGINT NOT NULL,topic VARCHAR(256) NOT NULL,agent LONGTEXT NOT NULL,instance LONGTEXT NOT NULL,body LONGTEXT NOT NULL,tags JSON NOT NULL,meta JSON NOT NULL,created_at BIGINT NOT NULL,edited_at BIGINT,deleted_at BIGINT,updated_seq BIGINT NOT NULL DEFAULT 0,previous LONGTEXT,mentions LONGTEXT NOT NULL DEFAULT ('[]'),previous_mentions LONGTEXT NOT NULL DEFAULT ('[]')) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
					yield* sql`CREATE UNIQUE INDEX messages_seq ON messages(seq)`;
					yield* sql`CREATE TABLE ${sql("reads")}(instance VARCHAR(256) NOT NULL,topic VARCHAR(256) NOT NULL,seq BIGINT NOT NULL,PRIMARY KEY(instance,topic)) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`;
				}),
		});
		yield* sql`CREATE INDEX topics_parent ON topics(parent)`;
		yield* sql`CREATE INDEX messages_topic_seq ON messages(topic,seq)`;
	});

export interface BoardShape {
	readonly seed: number;
	readonly topics: number;
	readonly messages: number;
	readonly bodyLength: number;
}

/** Returns the publication ceiling; rows above it carry published before-images or are not yet visible. */
export const seedBoard = (sql: SqlClient, shape: BoardShape, pagesDirectory: string | undefined) =>
	Effect.gen(function* () {
		const next = random(shape.seed);
		const pick = <A>(items: readonly A[]): A => items[Math.floor(next() * items.length)] as A;
		const ceiling = shape.messages - 25;
		const paths: string[] = [];
		const roots = Math.min(25, shape.topics);
		for (let index = 0; index < roots; index++) paths.push(`r${String(index).padStart(2, "0")}`);
		while (paths.length < shape.topics) {
			const parent = pick(paths);
			if (parent.split("/").length >= 4) continue;
			paths.push(`${parent}/c${paths.length}`);
		}
		const topicRows = paths.map((path, index) => {
			const roll = next();
			const archived = roll < 0.08 ? 1000 + index : null;
			const deleted = roll > 0.98 ? 2000 + index : null;
			// A newer, unpublished image flips archive or deletion; readers must still see the previous one.
			const unpublished = next() < 0.04;
			const previous = unpublished
				? JSON.stringify({
						meta: { image: "published", index },
						archived_at: archived === null ? 3000 + index : null,
						deleted_at: deleted === null && next() < 0.3 ? 4000 + index : null,
					})
				: null;
			const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
			return {
				path,
				parent,
				name: path.split("/").at(-1) ?? path,
				meta: JSON.stringify({ image: "current", index }),
				last_seq: 0,
				created_at: index,
				archived_at: archived,
				updated_seq: unpublished ? ceiling + 1 + (index % 20) : index % 50,
				previous,
				deleted_at: deleted,
			};
		});
		// A topic created after the ceiling has no published image at all.
		topicRows.push({
			path: "r01/fresh",
			parent: "r01",
			name: "fresh",
			meta: "{}",
			last_seq: 0,
			created_at: 0,
			archived_at: null,
			updated_seq: ceiling + 3,
			previous: null,
			deleted_at: null,
		});
		// A live root whose deleted and archived subtrees still receive messages.
		const fixed = [
			["zz", null, null],
			["zz/removed", null, 7000],
			["zz/removed/child", null, null],
			["zz/shelved", 7001, null],
			["zz/shelved/inner", null, null],
		] as const;
		for (const [path, archived_at, deleted_at] of fixed)
			topicRows.push({
				path,
				parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null,
				name: path.split("/").at(-1) ?? path,
				meta: "{}",
				last_seq: 0,
				created_at: 0,
				archived_at,
				updated_seq: 0,
				previous: null,
				deleted_at,
			});
		for (let start = 0; start < topicRows.length; start += 200)
			yield* sql`INSERT INTO topics ${sql.insert(topicRows.slice(start, start + 200))}`;
		// Skewed traffic: a few hot topics, a long tail, and one message topic with no topic row.
		const weights = paths.map(() => Math.pow(next(), 3));
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		const cumulative = weights.map(
			(
				(sum) => (weight: number) =>
					(sum += weight / total)
			)(0),
		);
		const words = ["alpha", "beta", "gamma", "delta", "board", "topic", "agent", "page", "mark", "seq"];
		const body = () =>
			Array.from({ length: Math.ceil(shape.bodyLength / 6) }, () => pick(words))
				.join(" ")
				.slice(0, Math.floor(shape.bodyLength * (0.5 + next())));
		const messageRows = Array.from({ length: shape.messages }, (_, index) => {
			const seq = index + 1;
			const roll = next();
			const topic =
				roll < 0.002
					? "r00/orphan"
					: roll < 0.004
						? "r01/fresh"
						: roll < 0.01
							? (fixed[Math.floor((roll - 0.004) / 0.0012)]?.[0] ?? "zz")
							: (paths[cumulative.findIndex((edge) => edge >= next())] ?? paths[0] ?? "r00");
			const deleted = next() < 0.05 ? 5000 + seq : null;
			const edited = next() < 0.01;
			return {
				id: `m${seq}`,
				seq,
				topic,
				agent: "writer",
				instance: "writer-session",
				body: body(),
				tags: "[]",
				meta: "{}",
				created_at: seq,
				edited_at: edited ? seq : null,
				deleted_at: deleted,
				updated_seq: edited ? ceiling + 1 + (seq % 20) : seq,
				previous: edited
					? JSON.stringify({
							body: "before",
							tags: [],
							meta: {},
							edited_at: null,
							deleted_at: deleted === null ? 6000 + seq : null,
						})
					: null,
			};
		});
		for (let start = 0; start < messageRows.length; start += 500)
			yield* sql`INSERT INTO messages ${sql.insert(messageRows.slice(start, start + 500))}`;
		const marks = [
			{ instance: "root-reader", topic: "", seq: Math.floor(ceiling * 0.7) },
			{ instance: "root-reader", topic: "r02", seq: Math.floor(ceiling * 0.9) },
			...paths
				.filter(() => next() < 0.15)
				.map((topic) => ({ instance: "nested-reader", topic, seq: Math.floor(ceiling * next()) })),
			...paths
				.filter((path) => path.includes("/") && next() < 0.3)
				.map((topic) => ({ instance: "deep-reader", topic, seq: Math.floor(ceiling * (0.5 + next() / 2)) })),
			{ instance: "deep-reader", topic: "r00", seq: Math.floor(ceiling * 0.95) },
			{ instance: "ahead-reader", topic: "r03", seq: ceiling + 10 },
		];
		yield* sql`INSERT INTO ${sql("reads")} ${sql.insert(marks)}`;
		yield* sql`INSERT INTO topic_page_continuations VALUES(1,'r04/moving','r04/moved','marker',0)`;
		yield* sql`INSERT INTO topic_page_continuations VALUES(2,'r05/done','r05/elsewhere','marker',1)`;
		if (pagesDirectory) {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			// Pages mirror half the topics and add page-only folders, like a board's memory and data mirrors.
			const directories = [
				...paths.filter(() => next() < 0.5),
				"r04/moving",
				"r04/moving/inner",
				"pages-only",
				"pages-only/nested",
				"pages-only/nested/deeper",
				"r00/page-folder",
				"Not-A-Topic",
			];
			for (const directory of directories) {
				yield* fs.makeDirectory(path.join(pagesDirectory, directory), { recursive: true });
				const files = Math.floor(next() * 6);
				for (let file = 0; file < files; file++)
					yield* fs.writeFileString(path.join(pagesDirectory, directory, `page-${file}.md`), `# ${directory}`);
			}
			yield* fs.writeFileString(path.join(pagesDirectory, "index.md"), "# Board");
			yield* fs.writeFileString(path.join(pagesDirectory, "r00", "index.md"), "# r00");
		}
		return { ceiling, paths };
	});

const StoredTopic = Schema.Struct({ ...TopicSummary.fields, meta: Schema.fromJsonString(Schema.JsonObject) });

/** The topic read as it was before rollup aggregation: the reference these tests compare against. */
export const legacyDetail = (
	sql: SqlClient,
	pages: Pages["Service"],
	ceiling: number,
	instance: string,
	path: string,
	depth = 1,
	archived = false,
) =>
	Effect.gen(function* () {
		const first = yield* pages
			.entries(path)
			.pipe(
				Effect.catchTag("PageRejected", (error) =>
					error.code === "page_not_found" || error.code === "pages_move_pending"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			);
		const directories: string[] = [];
		const visit = (
			base: string,
			children: NonNullable<typeof first>,
			remaining: number,
		): Effect.Effect<void, PageRejected | PlatformError.PlatformError> =>
			Effect.gen(function* () {
				for (const child of children) {
					const childName = base ? `${base}/${child.name}` : child.name;
					if (!child.directory || !validTopic(childName)) continue;
					directories.push(childName);
					if (remaining > 1) yield* visit(childName, yield* pages.entries(childName), remaining - 1);
				}
			});
		if (first) yield* visit(path, first, depth);
		const pageFiles = first ? first.filter((entry) => !entry.directory).map((entry) => entry.name) : [];
		const page = {
			exists: first !== null,
			index: pageFiles.includes("index.md") ? yield* pages.read(path ? `${path}/index.md` : "index.md") : null,
			pages: pageFiles,
			directories,
		};
		const rows =
			yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}), visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT t.path,t.name,t.meta,t.archived_at,
   COALESCE((SELECT MAX(m.seq) FROM visible_messages m WHERE m.seq<=${ceiling} AND (m.topic=t.path OR ${isDescendant(sql, sql("m.topic"), sql("t.path"))})),0) AS last_seq,
   (SELECT COUNT(*) FROM visible_messages m WHERE m.deleted_at IS NULL AND m.seq<=${ceiling} AND (m.topic=t.path OR ${isDescendant(sql, sql("m.topic"), sql("t.path"))})
    AND NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (m.topic=a.path OR ${isDescendant(sql, sql("m.topic"), sql("a.path"))}))
    AND m.seq>COALESCE((SELECT MAX(r.seq) FROM ${sql("reads")} r WHERE r.instance=${instance} AND (r.topic='' OR r.topic=m.topic OR ${isDescendant(sql, sql("m.topic"), sql("r.topic"))})),0)) AS unread
   FROM visible_topics t WHERE NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.deleted_at IS NOT NULL AND (t.path=a.path OR ${isDescendant(sql, sql("t.path"), sql("a.path"))})) AND (${path}='' OR t.path=${path} OR ${isDescendant(sql, sql("t.path"), path)})
   AND (${archived ? 1 : 0}=1 OR t.path=${path} OR NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (t.path=a.path OR ${isDescendant(sql, sql("t.path"), sql("a.path"))})))
   ORDER BY last_seq DESC,t.path`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredTopic))));
		const named = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })));
		const deletedTopics =
			yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE deleted_at IS NOT NULL`.pipe(
				Effect.flatMap(named),
			);
		if (deletedTopics.some((row) => path === row.path || path.startsWith(`${row.path}/`))) return "topic_not_found";
		const visible = [...rows];
		const archivedTopics =
			yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}) SELECT path FROM visible_topics WHERE archived_at IS NOT NULL`.pipe(
				Effect.flatMap(named),
			);
		for (const directory of page.directories) {
			if (
				visible.some((row) => row.path === directory) ||
				deletedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)) ||
				(!archived && archivedTopics.some((row) => directory === row.path || directory.startsWith(`${row.path}/`)))
			)
				continue;
			visible.push({
				path: directory,
				name: directory.split("/").at(-1) ?? directory,
				meta: {},
				last_seq: 0,
				unread: 0,
				archived_at: null,
			});
		}
		visible.sort((a, b) => b.last_seq - a.last_seq || a.path.localeCompare(b.path));
		const own = visible.find((row) => row.path === path);
		if (path !== "" && !own && !page.exists) return "topic_not_found";
		const segments = path === "" ? 0 : path.split("/").length;
		const subtopics = visible.filter((row) => row.path !== path && row.path.split("/").length <= segments + depth);
		const recent =
			yield* sql`WITH visible_topics AS (${publishedTopics(sql, ceiling)}), visible_messages AS (${publishedMessages(sql, ceiling)}) SELECT * FROM visible_messages WHERE deleted_at IS NULL AND (${path}='' OR topic=${path}) AND seq<=${ceiling} AND (${path}<>'' OR NOT EXISTS(SELECT 1 FROM visible_topics a WHERE a.archived_at IS NOT NULL AND (visible_messages.topic=a.path OR ${isDescendant(sql, sql("visible_messages.topic"), sql("a.path"))}))) ORDER BY seq DESC LIMIT 100`.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(StoredMessage))),
			);
		return {
			path,
			meta: own?.meta ?? {},
			archived_at: own?.archived_at ?? null,
			archived_root:
				archivedTopics
					.filter((row) => path === row.path || path.startsWith(`${row.path}/`))
					.sort((left, right) => left.path.length - right.path.length)[0]?.path ?? null,
			subtopics,
			messages: [...recent].reverse(),
			fence: ceiling,
			unread: own?.unread ?? rows.filter((row) => !row.path.includes("/")).reduce((sum, row) => sum + row.unread, 0),
			index: page.index,
			pages: page.pages,
		};
	});
