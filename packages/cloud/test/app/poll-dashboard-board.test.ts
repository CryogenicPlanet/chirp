import { describe, expect, test, vi } from "vitest";
import type { DashboardBoard } from "../../src/dashboard-contract.ts";
import { pollDashboardBoard } from "../../src/app/poll-dashboard-board.ts";

const board = (phase: DashboardBoard["phase"]): DashboardBoard => ({
	id: "board-1",
	name: "Private board",
	hostname: phase === "ready" ? "opaque.boards.chirp.wiki" : null,
	storage_engine: "sqlite",
	channel: "latest",
	region: null,
	volume_size_gb: null,
	phase,
	checkpoint: phase,
	created_at: "2026-09-20T00:00:00.000Z",
	last_backup: null,
	error: null,
});

describe("pollDashboardBoard", () => {
	test("waits between sequential requests and stops at a terminal state", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		let active = 0;
		let maximumActive = 0;
		const load = vi
			.fn<(_: AbortSignal) => Promise<DashboardBoard>>()
			.mockImplementationOnce(async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 3_000));
				active -= 1;
				return board("provisioning");
			})
			.mockImplementationOnce(async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 3_000));
				active -= 1;
				return board("ready");
			});
		const seen: DashboardBoard[] = [];
		const polling = pollDashboardBoard({
			signal: controller.signal,
			load,
			onBoard: (value) => seen.push(value),
			onError: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(2_500);
		expect(active).toBe(1);
		expect(load).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([]);
		await vi.advanceTimersByTimeAsync(5_500);
		await polling;
		expect(load).toHaveBeenCalledTimes(2);
		expect(maximumActive).toBe(1);
		expect(seen.map(({ phase }) => phase)).toEqual(["provisioning", "ready"]);
		expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		vi.useRealTimers();
	});

	test("aborts without another request or a visible error", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const load = vi.fn(async () => board("queued"));
		const onError = vi.fn();
		const polling = pollDashboardBoard({ signal: controller.signal, load, onBoard: vi.fn(), onError });
		await Promise.resolve();
		controller.abort();
		await polling;
		expect(load).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	test("retains the last board and recovers after a transient request failure", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const failure = new Error("status unavailable");
		const load = vi
			.fn<(_: AbortSignal) => Promise<DashboardBoard>>()
			.mockResolvedValueOnce(board("provisioning"))
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(board("ready"));
		const seen: DashboardBoard[] = [];
		const onError = vi.fn();
		const polling = pollDashboardBoard({
			signal: controller.signal,
			load,
			onBoard: (value) => seen.push(value),
			onError,
		});
		await vi.advanceTimersByTimeAsync(4_000);
		await polling;
		expect(seen.map(({ phase }) => phase)).toEqual(["provisioning", "ready"]);
		expect(onError).toHaveBeenCalledWith(failure);
		vi.useRealTimers();
	});

	test("stops after a terminal request failure", async () => {
		const failure = new Error("not found");
		const load = vi.fn<(_: AbortSignal) => Promise<DashboardBoard>>().mockRejectedValue(failure);
		const onError = vi.fn();
		await pollDashboardBoard({
			signal: new AbortController().signal,
			load,
			onBoard: vi.fn(),
			onError,
			shouldRetry: (error) => error !== failure,
		});
		expect(load).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(failure);
	});
	test("keeps checking deletion until its terminal state", async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const load = vi
				.fn<(_: AbortSignal) => Promise<DashboardBoard>>()
				.mockResolvedValueOnce(board("deleting"))
				.mockResolvedValueOnce(board("deletion_blocked"));
			const seen: DashboardBoard[] = [];
			const onError = vi.fn();
			const polling = pollDashboardBoard({
				signal: controller.signal,
				load,
				onBoard: (value) => seen.push(value),
				onError,
			});
			await vi.advanceTimersByTimeAsync(2_000);
			await polling;
			expect(seen.map(({ phase }) => phase)).toEqual(["deleting", "deletion_blocked"]);
			expect(onError).not.toHaveBeenCalled();
			expect(load).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
