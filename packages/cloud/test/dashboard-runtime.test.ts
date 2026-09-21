import { BoardSetup } from "../src/board-setup.ts";
import { BoardDeletion } from "../src/board-deletion.ts";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors";
import { Effect, Layer, Option } from "effect";
import { describe, expect, test, vi } from "vitest";
import type { DashboardBoard } from "../src/dashboard-contract.ts";
import { makeDashboardRequestRuntime } from "../src/dashboard-runtime.ts";
import { Invitations } from "../src/invitations.ts";
import { Dashboard } from "../src/dashboard.ts";
import { makeDashboardHttp } from "../src/dashboard-http.ts";

const board: DashboardBoard = {
	id: "board-1",
	name: "Board",
	hostname: null,
	storage_engine: "sqlite",
	region: null,
	volume_size_gb: null,
	phase: "queued",
	checkpoint: "requested",
	created_at: "2026-09-20T00:00:00.000Z",
	last_backup: null,
	error: null,
};

const invitationsStub = Layer.succeed(
	Invitations,
	Invitations.of({
		issue: () => Effect.die("Unexpected invitation issuance"),
		canIssue: () => Effect.succeed(false),
		issueForOperator: () => Effect.die("Unexpected invitation issuance"),
	}),
);

describe("dashboard request runtime", () => {
	test("builds once for concurrent requests and awaits scoped disposal", async () => {
		let builds = 0;
		let closed = false;
		const release = Promise.withResolvers<void>();
		const finalizing = Promise.withResolvers<void>();
		const runtime = makeDashboardRequestRuntime(
			Layer.effect(
				Dashboard,
				Effect.acquireRelease(
					Effect.sync(() => {
						builds += 1;
						return Dashboard.of({
							list: () =>
								Effect.succeed({
									boards: [board],
									truncated: false,
									capabilities: { postgres: false },
									boards_domain: "boards.chirp.wiki",
								}),
							get: () => Effect.succeedSome(board),
							create: () => Effect.succeed(board),
						});
					}),
					() =>
						Effect.promise(() => {
							finalizing.resolve();
							return release.promise.then(() => {
								closed = true;
							});
						}),
				),
			).pipe(
				Layer.merge(invitationsStub),
				Layer.merge(Layer.succeed(BoardSetup, { issue: () => Effect.die("Unexpected setup request") })),
				Layer.merge(
					Layer.succeed(BoardDeletion, BoardDeletion.of({ request: () => Effect.succeed({ deleted: true }) })),
				),
			),
		);
		try {
			await Promise.all(Array.from({ length: 24 }, () => runtime.list("owner")));
			expect(await runtime.get("owner", board.id)).toEqual(Option.some(board));
			expect(await runtime.create("owner", { name: board.name, idempotency_key: "key" })).toEqual({ ok: true, board });
			expect(builds).toBe(1);
			let disposed = false;
			const disposal = runtime.dispose().then(() => {
				disposed = true;
			});
			await finalizing.promise;
			expect(disposed).toBe(false);
			expect(closed).toBe(false);
			release.resolve();
			await disposal;
			expect(closed).toBe(true);
			await expect(runtime.list("owner")).rejects.toBeDefined();
		} finally {
			release.resolve();
			await runtime.dispose();
		}
	});

	test.each(["defects", "query failures"])(
		"logs %s before mapping them to a redacted dashboard 503",
		async (failure) => {
			const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
			const fail = (marker: string) =>
				failure === "defects"
					? Effect.die(marker)
					: Effect.fail(new EffectDrizzleQueryError({ query: marker, params: [], cause: marker }));
			const runtime = makeDashboardRequestRuntime(
				Layer.succeed(
					Dashboard,
					Dashboard.of({
						list: () => fail("list defect marker"),
						get: () => fail("detail defect marker"),
						create: () => fail("create defect marker"),
					}),
				).pipe(
					Layer.merge(invitationsStub),
					Layer.merge(Layer.succeed(BoardSetup, { issue: () => Effect.die("Unexpected setup request") })),
					Layer.merge(
						Layer.succeed(BoardDeletion, BoardDeletion.of({ request: () => Effect.succeed({ deleted: true }) })),
					),
				),
			);
			const http = makeDashboardHttp({
				...runtime,
				getSession: async () => ({
					session: { user: { id: "owner", name: "Owner", email: "owner@example.com" } },
					headers: new Headers(),
				}),
				getPublicOrigin: async () => "https://cloud.test",
			});
			try {
				const request = new Request("https://cloud.test/api/boards", {
					method: "POST",
					headers: { origin: "https://cloud.test", "content-type": "application/json", "idempotency-key": "key" },
					body: JSON.stringify({ name: "Board" }),
				});
				for (const response of [
					await http.list(request),
					await http.detail(request, "01956d31-c55b-7a01-9088-927182bece80"),
					await http.create(request),
				]) {
					expect(response.status).toBe(503);
					expect(await response.json()).toEqual({ error: { code: "dashboard_unavailable" } });
					expect(response.headers.get("cache-control")).toBe("no-store");
				}
				expect(logged).toHaveBeenCalledTimes(3);
				for (const [index, route] of ["list", "detail", "create"].entries()) {
					const message = logged.mock.calls[index]?.join("\n");
					expect(message).toContain(`Chirp Cloud dashboard ${route} failed`);
					if (route === "create") expect(message).not.toContain(`${route} defect marker`);
					else expect(message).toContain(`${route} defect marker`);
				}
			} finally {
				await runtime.dispose();
				logged.mockRestore();
			}
		},
	);
});
