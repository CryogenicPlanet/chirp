import { eq } from "drizzle-orm";
import { Effect, Exit, Option } from "effect";
import { describe, expect, test } from "vitest";
import { Boards } from "../src/boards.ts";
import { Database } from "../src/database.ts";
import { migrateCloudDatabase } from "../src/migrations.ts";
import { boardOperations, boards as boardTable } from "../src/schema.ts";
import { runFresh } from "./fixture.ts";

const request = {
	owner_id: "user-1",
	name: "My board",
	storage_engine: "sqlite",
	requested_by: "user-1",
	idempotency_key: "request-1",
} as const;

describe("Boards", () => {
	test("atomically creates a board and its initial provision operation", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const database = yield* Database;
				const board = yield* boards.request(request);
				expect(board.slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
				expect(
					yield* database
						.select({
							kind: boardOperations.kind,
							state: boardOperations.state,
							checkpoint: boardOperations.checkpoint,
						})
						.from(boardOperations)
						.where(eq(boardOperations.board_id, board.id)),
				).toEqual([{ kind: "provision", state: "queued", checkpoint: "requested" }]);
			}),
		);
	});

	test("replays the same request and rejects a changed body", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const first = yield* boards.request(request);
				const repeated = yield* boards.request(request);
				expect(repeated.id).toBe(first.id);
				const changed = yield* Effect.exit(boards.request({ ...request, name: "A different board" }));
				expect(Exit.isFailure(changed)).toBe(true);
			}),
		);
	});

	test("scopes reads to the owning user", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const board = yield* boards.request(request);
				expect(Option.isSome(yield* boards.get(request.owner_id, board.id))).toBe(true);
				expect(Option.isNone(yield* boards.get("user-2", board.id))).toBe(true);
				expect((yield* boards.list(request.owner_id)).map(({ id }) => id)).toEqual([board.id]);
				expect(yield* boards.list("user-2")).toEqual([]);
			}),
		);
	});

	test("enforces a five-board owner quota atomically while preserving replay", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const database = yield* Database;
				const first = yield* boards.request(request);
				const results = yield* Effect.forEach(
					Array.from({ length: 12 }, (_, index) => index),
					(index) =>
						boards
							.request({ ...request, idempotency_key: `quota-${index}` })
							.pipe(Effect.match({ onSuccess: () => "created", onFailure: (error) => error._tag })),
					{ concurrency: "unbounded" },
				);
				expect(results.filter((result) => result === "created")).toHaveLength(4);
				expect(results.filter((result) => result === "BoardQuotaExceeded")).toHaveLength(8);
				expect(yield* boards.list(request.owner_id)).toHaveLength(5);
				expect(yield* database.select({ id: boardOperations.id }).from(boardOperations)).toHaveLength(5);
				expect((yield* boards.request(request)).id).toBe(first.id);
				const conflict = yield* boards
					.request({ ...request, name: "Changed" })
					.pipe(Effect.match({ onSuccess: () => "created", onFailure: (error) => error._tag }));
				expect(conflict).toBe("IdempotencyConflict");
				const other = yield* boards.request({ ...request, owner_id: "user-2", requested_by: "user-2" });
				expect(other.owner_id).toBe("user-2");
			}),
		);
	});

	test("replays concurrent retries for the final quota slot", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				for (let index = 0; index < 4; index += 1)
					yield* boards.request({ ...request, idempotency_key: `prefill-${index}` });
				const created = yield* Effect.forEach(Array.from({ length: 12 }), () => boards.request(request), {
					concurrency: "unbounded",
				});
				expect(new Set(created.map(({ id }) => id)).size).toBe(1);
				expect(yield* boards.list(request.owner_id)).toHaveLength(5);
			}),
		);
	});

	test("generates a unique readable slug for each board", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const created = yield* Effect.forEach(
					Array.from({ length: 24 }, (_, index) => index),
					(index) =>
						boards.request({
							...request,
							owner_id: `owner-${index}`,
							name: `Board ${index}`,
							idempotency_key: `request-${index}`,
						}),
				);
				expect(new Set(created.map(({ slug }) => slug)).size).toBe(created.length);
			}),
		);
	});
	test("reserves custom slugs globally including deleted boards, and fingerprints slug changes", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const input = { ...request, slug: "quiet-robin" };
				const board = yield* boards.request(input);
				expect(board.slug).toBe("quiet-robin");
				expect((yield* boards.request(input)).id).toBe(board.id);
				const changed = yield* boards.request({ ...input, slug: "bright-lark" }).pipe(Effect.flip);
				expect(changed._tag).toBe("IdempotencyConflict");
				yield* (yield* Database).update(boardTable).set({ deleted_at: new Date() }).where(eq(boardTable.id, board.id));
				const unavailable = yield* boards
					.request({ ...input, owner_id: "other", requested_by: "other" })
					.pipe(Effect.flip);
				expect(unavailable._tag).toBe("BoardSlugUnavailable");
			}),
		);
	});
	test("concurrent owners cannot claim the same address", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				const results = yield* Effect.forEach(
					["one", "two"],
					(owner) =>
						boards
							.request({ ...request, owner_id: owner, requested_by: owner, slug: "shared-robin" })
							.pipe(Effect.match({ onSuccess: () => "created", onFailure: (error) => error._tag })),
					{ concurrency: "unbounded" },
				);
				expect(results.sort()).toEqual(["BoardSlugUnavailable", "created"]);
			}),
		);
	});
	test("rejects invalid slugs and accepts both bounds without changing the name", async () => {
		await runFresh(
			Effect.gen(function* () {
				yield* migrateCloudDatabase;
				const boards = yield* Boards;
				for (const slug of [
					"",
					"ab",
					"Aaa",
					"a_b",
					"-aaa",
					"aaa-",
					"a.b",
					"a/b",
					"xn--a",
					"a".repeat(33),
					" abc",
					"abc ",
				]) {
					expect((yield* boards.request({ ...request, slug }).pipe(Effect.flip))._tag).toBe("InvalidBoardSlug");
				}
				for (const slug of ["abc", "a".repeat(32)]) {
					const board = yield* boards.request({ ...request, slug, idempotency_key: slug });
					expect(board.name).toBe(request.name);
					expect(board.slug).toBe(slug);
				}
			}),
		);
	});
});
