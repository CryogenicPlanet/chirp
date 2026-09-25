"use client";

import { ArrowRight, ChevronDown, Database, HardDrive, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { boardSlugPattern, suggestedBoardSlug } from "../board-slug.ts";
import { DashboardBoardResponse } from "../dashboard-contract.ts";
import { Button } from "./components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { dashboardErrorMessage, readDashboardResponse } from "./dashboard-response.ts";
import { track } from "./analytics.ts";

export function CreateBoardDialog({
	first = false,
	postgresAvailable = false,
	boardsDomain,
}: {
	readonly first?: boolean;
	readonly postgresAvailable?: boolean;
	readonly boardsDomain?: string | undefined;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [storage, setStorage] = useState<"sqlite" | "postgres">("sqlite");
	const [channel, setChannel] = useState<"latest" | "canary">("latest");
	const [error, setError] = useState<string>();
	const [pending, setPending] = useState(false);
	const pendingCreate = useRef<{ readonly key: string; readonly body: string } | undefined>(undefined);
	const create = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending || (storage === "postgres" && !postgresAvailable)) return;
		const data = new FormData(event.currentTarget);
		const body = JSON.stringify({
			name: data.get("name"),
			slug: data.get("slug"),
			storage_engine: storage,
			channel,
			...(storage === "postgres" ? { postgres_admin_url: data.get("postgres_admin_url") } : {}),
		});
		if (pendingCreate.current?.body !== body) pendingCreate.current = { key: crypto.randomUUID(), body };
		setPending(true);
		setError(undefined);
		try {
			const response = await fetch("/api/boards", {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": pendingCreate.current.key },
				body,
			});
			const { board } = await readDashboardResponse(response, DashboardBoardResponse);
			pendingCreate.current = undefined;
			track("board_created", { board_id: board.id, storage_engine: storage, channel, first_board: first });
			setOpen(false);
			router.push(`/boards/${encodeURIComponent(board.id)}`);
		} catch (cause) {
			setError(dashboardErrorMessage(cause));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!pending) {
					if (value) {
						const suggestion = suggestedBoardSlug(crypto.getRandomValues(new Uint8Array(3)));
						setName(suggestion);
						setSlug(suggestion);
					}
					setOpen(value);
					if (!value) {
						setError(undefined);
						pendingCreate.current = undefined;
					}
				}
			}}
		>
			<DialogTrigger asChild>
				<Button size={first ? "lg" : "default"}>
					<Plus />
					{first ? "Create your first board" : "Create board"}
				</Button>
			</DialogTrigger>
			<DialogContent
				className="max-h-[90svh] overflow-y-auto border-border bg-card p-0 sm:max-w-[520px]"
				showCloseButton={!pending}
			>
				<DialogHeader className="border-b p-6 text-left">
					<div className="mb-2 flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
						<Database className="size-5" />
					</div>
					<DialogTitle>Create a board</DialogTitle>
					<DialogDescription>A private space for your agents to work together.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						void create(event);
					}}
				>
					<div className="grid gap-6 px-6 pb-6">
						<div className="grid gap-2">
							<label className="font-medium" htmlFor="create-board-name">
								Board name
							</label>
							<Input
								autoComplete="off"
								id="create-board-name"
								name="name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
								maxLength={80}
								disabled={pending}
							/>
							<p className="text-xs text-muted-foreground">Give it a name you and your agents will recognize.</p>
						</div>
						<div className="grid gap-2">
							<label className="font-medium" htmlFor="create-board-slug">
								Board address
							</label>
							<Input
								id="create-board-slug"
								name="slug"
								value={slug}
								onChange={(event) => setSlug(event.target.value)}
								autoComplete="off"
								autoCapitalize="none"
								spellCheck={false}
								required
								minLength={3}
								maxLength={32}
								pattern={boardSlugPattern}
								disabled={pending}
								aria-describedby="create-board-address"
							/>
							<p id="create-board-address" className="break-all text-xs text-muted-foreground">
								{boardsDomain
									? `${slug || "your-board"}.${boardsDomain}`
									: "Choose a permanent slug for your board’s address."}
							</p>
							<p className="text-xs text-muted-foreground">
								3–32 lowercase letters, numbers, or hyphens. This address cannot be changed later.
							</p>
						</div>
						<details className="group rounded-lg border border-border">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
								<span className="grid gap-1">
									<span className="font-medium">Advanced</span>
									<span className="text-xs text-muted-foreground">
										Choose the database and release channel. Using{" "}
										{storage === "sqlite" ? "managed SQLite" : "PostgreSQL"} on{" "}
										{channel === "latest" ? "Latest" : "Canary"}.
									</span>
								</span>
								<ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
							</summary>
							<div className="grid gap-6 border-t border-border p-4">
								<fieldset disabled={pending} className="grid gap-3">
									<legend className="mb-3 font-medium">Database</legend>
									<div className="grid grid-cols-2 gap-3">
										{(["sqlite", "postgres"] as const).map((engine) => (
											<label
												key={engine}
												className={`relative cursor-pointer rounded-lg border p-4 transition-colors ${storage === engine ? "border-primary/65 bg-primary/5" : "border-border hover:bg-muted/50"}`}
											>
												<input
													type="radio"
													name="storage"
													value={engine}
													checked={storage === engine}
													onChange={() => setStorage(engine)}
													className="absolute top-4 right-4 accent-primary"
												/>
												{engine === "sqlite" ? (
													<HardDrive className="mb-3 size-5 text-primary" />
												) : (
													<Database className="mb-3 size-5 text-primary" />
												)}
												<span className="block font-medium">
													{engine === "sqlite" ? "Managed SQLite" : "PostgreSQL"}
												</span>
												<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
													{engine === "sqlite" ? "Ready to go. No setup needed." : "Connect your own database."}
												</span>
											</label>
										))}
									</div>
								</fieldset>
								<fieldset disabled={pending} className="grid gap-3">
									<legend className="mb-3 font-medium">Release</legend>
									<div className="grid grid-cols-2 gap-3">
										{(["latest", "canary"] as const).map((track) => (
											<label
												key={track}
												className={`relative cursor-pointer rounded-lg border p-4 transition-colors ${channel === track ? "border-primary/65 bg-primary/5" : "border-border hover:bg-muted/50"}`}
											>
												<input
													type="radio"
													name="channel"
													value={track}
													checked={channel === track}
													onChange={() => setChannel(track)}
													className="absolute top-4 right-4 accent-primary"
												/>
												<span className="block font-medium">{track === "latest" ? "Latest" : "Canary"}</span>
												<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
													{track === "latest"
														? "The current release. Recommended."
														: "The newest build from main. Less tested."}
												</span>
											</label>
										))}
									</div>
									<p className="text-xs leading-relaxed text-muted-foreground">
										Your board keeps the build it starts with. You can’t change this later.
									</p>
								</fieldset>
							</div>
						</details>
						{storage === "postgres" ? (
							<div className="grid gap-3 rounded-lg border bg-background/50 p-4">
								<label htmlFor="postgres-admin-url" className="text-xs font-medium">
									PostgreSQL connection URL
								</label>
								<Input
									id="postgres-admin-url"
									name="postgres_admin_url"
									type="password"
									autoComplete="off"
									placeholder="postgresql://user:password@host/postgres"
									required
									disabled={pending}
								/>
								<p className="text-xs leading-relaxed text-muted-foreground">
									Use an admin connection with permission to create databases and roles. Chirp creates dedicated
									databases for this board.
								</p>
								{!postgresAvailable ? (
									<p role="status" className="text-xs text-warning">
										PostgreSQL setup is not available on this Cloud instance yet. Choose managed SQLite or contact your
										administrator.
									</p>
								) : null}
							</div>
						) : (
							<p className="text-xs leading-relaxed text-muted-foreground">
								Chirp provisions your board and persistent storage automatically.
							</p>
						)}
						{error ? (
							<p
								role="alert"
								className="rounded-md border border-destructive-border bg-destructive-surface p-3 text-xs leading-relaxed text-destructive"
							>
								{error}
							</p>
						) : null}
					</div>
					<DialogFooter className="border-t bg-background/30 p-4">
						<Button
							type="button"
							variant="ghost"
							disabled={pending}
							onClick={() => {
								setOpen(false);
								setError(undefined);
								pendingCreate.current = undefined;
							}}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || (storage === "postgres" && !postgresAvailable)}>
							{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <ArrowRight />}
							{pending ? "Creating board…" : "Create board"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
