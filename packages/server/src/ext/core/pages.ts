import { isDescendant, readTransaction } from "@comms/storage/dialect";
import { makePageContinuation, pendingPageMove } from "./topic-page-continuation.ts";
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema, type PlatformError } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { BootChannel } from "../../kernel/boot-channel.ts";
import { assertSqlPublished } from "../../kernel/sql-publication.ts";
import { HealthProbe } from "../../kernel/health-probe.ts";
import { publishedTopics } from "./published-topics.ts";
import { pageMarkdown } from "../../page-markdown.ts";
import { validTopic } from "./messages.ts";

export class PageRejected extends Schema.TaggedError<PageRejected>()("PageRejected", {
	code: Schema.Literals(["page_not_found", "page_path_invalid", "pages_unavailable", "pages_move_pending"]),
}) {}
export const validPagePath = (name: string) =>
	name === "" ||
	(!/[\\:]/.test(name) &&
		Array.from(name).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
		name
			.split("/")
			.every(
				(part) =>
					part !== "" &&
					part !== "." &&
					part !== ".." &&
					part !== "node_modules" &&
					part !== ".vite" &&
					!part.startsWith(".comms-"),
			));
const make = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const render = pageMarkdown();
		const move = yield* makePageContinuation(directory);
		const sql = yield* SqlClient.SqlClient;
		const boot = yield* BootChannel;
		const ceiling = Effect.gen(function* () {
			const probe = Option.getOrNull(yield* Effect.serviceOption(HealthProbe));
			const ceiling = probe ? yield* Ref.get(probe.ceiling) : (yield* boot.fence).published_through;
			if (!probe) yield* assertSqlPublished(sql, boot.epoch, ceiling);
			return ceiling;
		});
		const visible = (name: string) =>
			readTransaction(
				sql,
				Effect.gen(function* () {
					yield* sql`SELECT epoch FROM kernel_writer`;
					if ((yield* pendingPageMove(sql, name)).length)
						return yield* new PageRejected({ code: "pages_move_pending" });
					const deleted =
						yield* sql`WITH visible_topics AS (${publishedTopics(sql, yield* ceiling)}) SELECT path FROM visible_topics WHERE deleted_at IS NOT NULL AND (path=${name} OR ${isDescendant(sql, name, sql("path"))}) LIMIT 1`;
					if (deleted.length) return yield* new PageRejected({ code: "page_not_found" });
				}),
			).pipe(
				Effect.mapError((error) =>
					error._tag === "PageRejected" ? error : new PageRejected({ code: "pages_unavailable" }),
				),
			);
		// A listing applies visible's rule to every entry from one snapshot of pending moves and deleted
		// topics, instead of one nested transaction per entry: a deep tree made thousands of round trips.
		const visibility = readTransaction(
			sql,
			Effect.gen(function* () {
				yield* sql`SELECT epoch FROM kernel_writer`;
				const moves = yield* sql`SELECT from_path,to_path FROM topic_page_continuations WHERE completed=0`.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(
							Schema.Array(Schema.Struct({ from_path: Schema.String, to_path: Schema.String })),
						),
					),
				);
				const deleted =
					yield* sql`WITH visible_topics AS (${publishedTopics(sql, yield* ceiling)}) SELECT path FROM visible_topics WHERE deleted_at IS NOT NULL`.pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ path: Schema.String })))),
					);
				const within = (name: string, ancestor: string) => name === ancestor || name.startsWith(`${ancestor}/`);
				const related = (name: string, other: string) => within(name, other) || within(other, name);
				return (name: string): Effect.Effect<void, PageRejected> =>
					moves.some((row) => related(name, row.from_path) || related(name, row.to_path))
						? Effect.fail(new PageRejected({ code: "pages_move_pending" }))
						: deleted.some((row) => within(name, row.path))
							? Effect.fail(new PageRejected({ code: "page_not_found" }))
							: Effect.void;
			}),
		).pipe(Effect.mapError(() => new PageRejected({ code: "pages_unavailable" })));

		const locate = (check: (name: string) => Effect.Effect<void, PageRejected>) =>
			Effect.fn("Pages.resolve")(
				// A listing passes its own canonical directory, so each child checks only its last segment.
				function* (name: string, canonicalParent?: string) {
					if (!validPagePath(name)) return yield* new PageRejected({ code: "page_path_invalid" });
					yield* check(name);
					const parts = name.split("/").filter(Boolean);
					let target =
						canonicalParent ?? path.join(yield* fs.realPath(path.dirname(directory)), path.basename(directory));
					for (const part of canonicalParent === undefined ? ["", ...parts] : parts.slice(-1)) {
						target = part ? path.join(target, part) : target;
						const canonical = yield* fs.realPath(target);
						if (canonical !== target) return yield* new PageRejected({ code: "page_path_invalid" });
					}
					const info = yield* fs.stat(target);
					if (info.type !== "File" && info.type !== "Directory")
						return yield* new PageRejected({ code: "page_path_invalid" });
					return { absolute: target, type: info.type };
				},
				(effect) =>
					effect.pipe(
						Effect.mapError((error) =>
							error._tag === "PageRejected"
								? error
								: new PageRejected({
										code: error.reason._tag === "NotFound" ? "page_not_found" : "pages_unavailable",
									}),
						),
					),
			);
		const list = (find: ReturnType<typeof locate>) =>
			Effect.fn("Pages.entries")(function* (name: string) {
				const target = yield* find(name);
				if (target.type !== "Directory") return yield* new PageRejected({ code: "page_not_found" });
				const names = yield* fs.readDirectory(target.absolute);
				const result: Array<{ readonly name: string; readonly directory: boolean }> = [];
				for (const child of names.sort()) {
					const childName = name ? `${name}/${child}` : child;
					const entry = yield* find(childName, target.absolute).pipe(
						Effect.catchTag("PageRejected", (error) =>
							error.code === "pages_unavailable" ? Effect.fail(error) : Effect.succeed(null),
						),
					);
					if (entry) result.push({ name: child, directory: entry.type === "Directory" });
				}
				return result;
			});
		const load = (find: ReturnType<typeof locate>) =>
			Effect.fn("Pages.read")(function* (name: string) {
				const target = yield* find(name);
				if (target.type !== "File") return yield* new PageRejected({ code: "page_not_found" });
				return yield* fs.readFileString(target.absolute);
			});
		const located = locate(visible);
		// The canonical-parent shortcut stays internal to listings; callers always get the full-path check.
		const resolve = (name: string) => located(name);
		const entries = list(located);
		const read = load(located);
		const topic = Effect.fn("Pages.topic")(function* (name: string, depth = 1) {
			const find = locate(yield* visibility);
			const listing = list(find);
			const first = yield* listing(name).pipe(
				Effect.catchTag("PageRejected", (error) =>
					error.code === "page_not_found" || error.code === "pages_move_pending"
						? Effect.succeed(null)
						: Effect.fail(error),
				),
			);
			if (!first) return { exists: false, index: null, pages: [], directories: [] };
			const directories: string[] = [];
			const visit = (
				base: string,
				children: typeof first,
				remaining: number,
			): Effect.Effect<void, PageRejected | PlatformError.PlatformError> =>
				Effect.gen(function* () {
					for (const child of children) {
						const childName = base ? `${base}/${child.name}` : child.name;
						if (!child.directory || !validTopic(childName)) continue;
						directories.push(childName);
						if (remaining > 1) yield* visit(childName, yield* listing(childName), remaining - 1);
					}
				});
			yield* visit(name, first, depth);
			const pages = first.filter((entry) => !entry.directory).map((entry) => entry.name);
			return {
				exists: true,
				index: pages.includes("index.md") ? yield* load(find)(name ? `${name}/index.md` : "index.md") : null,
				pages,
				directories,
			};
		});
		return { resolve, entries, read, topic, render, move };
	});
/** Reads only the page tree supplied by boot. Paths never follow symlinks. */
export class Pages extends Context.Service<Pages, Effect.Success<ReturnType<typeof make>>>()("comms/server/Pages") {}
export const layer = (directory: string) => Layer.effect(Pages, make(directory));
