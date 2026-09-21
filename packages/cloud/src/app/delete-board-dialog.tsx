"use client";

import { Schema } from "effect";
import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DashboardBoardResponse, type DashboardBoard } from "../dashboard-contract.ts";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "./components/ui/alert-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

const deletedResponse = Schema.Struct({ deleted: Schema.Literal(true) });

export function DeleteBoardDialog({
	board,
	onDeleted,
}: {
	readonly board: DashboardBoard;
	readonly onDeleted: () => void;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const requestKey = useRef<string | undefined>(undefined);
	const remove = async () => {
		if (pending || name !== board.name) return;
		requestKey.current ??= crypto.randomUUID();
		setPending(true);
		setError(undefined);
		try {
			const response = await fetch(`/api/boards/${encodeURIComponent(board.id)}`, {
				method: "DELETE",
				headers: { "content-type": "application/json", "idempotency-key": requestKey.current },
				body: JSON.stringify({ confirmation_name: name }),
			});
			if (!response.ok) {
				setError(
					response.status === 409
						? "This board can't be deleted right now. Another operation may be running, or its resources need verification. Refresh and try again."
						: response.status === 400
							? "The board name doesn't match. Check it and try again."
							: "We couldn't delete this board. Please try again.",
				);
				return;
			}
			if (response.status === 202) {
				Schema.decodeUnknownSync(DashboardBoardResponse)(await response.json());
				requestKey.current = undefined;
				setName("");
				setError(undefined);
				setOpen(false);
				onDeleted();
			} else {
				Schema.decodeUnknownSync(deletedResponse)(await response.json());
				setOpen(false);
				router.push("/");
			}
		} catch {
			setError("We couldn't reach Chirp Cloud. Check your connection and try again.");
		} finally {
			setPending(false);
		}
	};
	return (
		<AlertDialog
			open={open}
			onOpenChange={(value) => {
				if (!pending) {
					setOpen(value);
					if (!value) {
						setName("");
						setError(undefined);
					}
				}
			}}
		>
			<AlertDialogTrigger asChild>
				<Button
					variant="outline"
					disabled={board.phase === "deleting"}
					className="text-destructive hover:bg-destructive/10"
				>
					<Trash2 />
					{board.phase === "deletion_blocked"
						? "Retry deletion"
						: board.phase === "deleting"
							? "Deleting…"
							: "Delete board"}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent className="bg-card">
				<AlertDialogHeader>
					<div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
						<Trash2 className="size-5" />
					</div>
					<AlertDialogTitle>Delete {board.name}?</AlertDialogTitle>
					<AlertDialogDescription>
						This permanently removes the board and its managed storage.{" "}
						{board.storage_engine === "sqlite"
							? "Its messages, pages, and files will be lost."
							: "Your external database and its data will be retained."}{" "}
						This can't be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="grid gap-2">
					<label htmlFor="delete-board-name" className="text-xs text-muted-foreground">
						Type <strong className="font-medium text-foreground">{board.name}</strong> to confirm.
					</label>
					<Input
						id="delete-board-name"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
						autoComplete="off"
						disabled={pending}
					/>
				</div>
				{error ? (
					<p role="alert" className="text-xs leading-relaxed text-destructive">
						{error}
					</p>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Keep board</AlertDialogCancel>
					<Button
						variant="destructive"
						disabled={pending || name !== board.name}
						onClick={() => {
							void remove();
						}}
					>
						{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Trash2 />}
						{pending ? "Deleting…" : "Delete permanently"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
