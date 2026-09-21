import type { DashboardBoard } from "../dashboard-contract.ts";

const wait = (milliseconds: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			finish();
		};
		signal.addEventListener("abort", abort, { once: true });
	});

export const pollDashboardBoard = async (input: {
	readonly signal: AbortSignal;
	readonly load: (signal: AbortSignal) => Promise<DashboardBoard>;
	readonly onBoard: (board: DashboardBoard) => void;
	readonly onError: (error: unknown) => void;
}) => {
	while (!input.signal.aborted) {
		try {
			const board = await input.load(input.signal);
			if (input.signal.aborted) return;
			input.onBoard(board);
			if (board.phase !== "queued" && board.phase !== "provisioning" && board.phase !== "deleting") return;
			await wait(2_000, input.signal);
		} catch (error) {
			if (!input.signal.aborted) input.onError(error);
			return;
		}
	}
};
