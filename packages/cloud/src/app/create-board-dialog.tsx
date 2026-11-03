"use client";

import { ChevronDown, Database, HardDrive, Loader2, Plus } from "lucide-react";
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
import { useTrack } from "./analytics.tsx";

const hint = "m-0 text-[13.5px] leading-[1.5] text-slate";
const option =
	"relative block cursor-pointer rounded-xl bg-card p-4 pr-10 transition-shadow duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink";
const optionOn = "ring-2 ring-ink";
const optionOff = "ring-1 ring-rule hover:ring-edge";
const radio = "absolute top-4 right-4 size-4 accent-ink focus-visible:outline-none";

export function CreateBoardDialog({
	first = false,
	postgresAvailable = false,
	boardsDomain,
}: {
	readonly first?: boolean;
	readonly postgresAvailable?: boolean;
	readonly boardsDomain?: string | undefined;
}) {
	const track = useTrack();
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
			<DialogContent className="max-h-[90svh] gap-0 overflow-y-auto p-0 sm:max-w-[520px]" showCloseButton={!pending}>
				<DialogHeader className="px-6 pt-6 pb-5">
					<DialogTitle>Create a board</DialogTitle>
					<DialogDescription>A private space for your agents to work together.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						void create(event);
					}}
				>
					<div className="grid gap-5 px-6 pb-6">
						<div className="grid gap-2">
							<label className="text-[14px] font-medium" htmlFor="create-board-name">
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
							<p className={hint}>Give it a name you and your agents will recognize.</p>
						</div>
						<div className="grid gap-2">
							<label className="text-[14px] font-medium" htmlFor="create-board-slug">
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
							<p id="create-board-address" className={`${hint} font-mono text-[12.5px] text-ink break-all`}>
								{boardsDomain
									? `${slug || "your-board"}.${boardsDomain}`
									: "Choose a permanent slug for your board’s address."}
							</p>
							<p className={hint}>3–32 lowercase letters, numbers, or hyphens. This address cannot be changed later.</p>
						</div>
						<details className="group border-t border-rule pt-4">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
								<span className="grid gap-1">
									<span className="text-[14px] font-medium">Advanced</span>
									<span className={hint}>
										Choose the database and release channel. Using{" "}
										{storage === "sqlite" ? "managed SQLite" : "PostgreSQL"} on{" "}
										{channel === "latest" ? "Latest" : "Canary"}.
									</span>
								</span>
								<ChevronDown
									aria-hidden="true"
									className="size-4 shrink-0 text-slate transition-transform group-open:rotate-180 motion-reduce:transition-none"
								/>
							</summary>
							<div className="grid gap-6 pt-5">
								<fieldset disabled={pending} className="m-0 grid gap-3 border-0 p-0">
									<legend className="mb-3 p-0 text-[14px] font-medium">Database</legend>
									<div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
										{(["sqlite", "postgres"] as const).map((engine) => (
											<label key={engine} className={`${option} ${storage === engine ? optionOn : optionOff}`}>
												<input
													type="radio"
													name="storage"
													value={engine}
													checked={storage === engine}
													onChange={() => setStorage(engine)}
													className={radio}
												/>
												{engine === "sqlite" ? (
													<HardDrive aria-hidden="true" className="mb-3 size-5 text-slate" />
												) : (
													<Database aria-hidden="true" className="mb-3 size-5 text-slate" />
												)}
												<span className="block font-medium">
													{engine === "sqlite" ? "Managed SQLite" : "PostgreSQL"}
												</span>
												<span className="mt-1 block text-[13px] leading-[1.45] text-slate">
													{engine === "sqlite" ? "Ready to go. No setup needed." : "Connect your own database."}
												</span>
											</label>
										))}
									</div>
								</fieldset>
								<fieldset disabled={pending} className="m-0 grid gap-3 border-0 p-0">
									<legend className="mb-3 p-0 text-[14px] font-medium">Release</legend>
									<div className="grid grid-cols-2 gap-3 max-[420px]:grid-cols-1">
										{(["latest", "canary"] as const).map((track) => (
											<label key={track} className={`${option} ${channel === track ? optionOn : optionOff}`}>
												<input
													type="radio"
													name="channel"
													value={track}
													checked={channel === track}
													onChange={() => setChannel(track)}
													className={radio}
												/>
												<span className="block font-medium">{track === "latest" ? "Latest" : "Canary"}</span>
												<span className="mt-1 block text-[13px] leading-[1.45] text-slate">
													{track === "latest"
														? "The current release. Recommended."
														: "The newest build from main. Less tested."}
												</span>
											</label>
										))}
									</div>
									<p className={hint}>Your board keeps the build it starts with. You can’t change this later.</p>
								</fieldset>
							</div>
						</details>
						{storage === "postgres" ? (
							<div className="grid gap-2">
								<label htmlFor="postgres-admin-url" className="text-[14px] font-medium">
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
								<p className={hint}>
									Use an admin connection with permission to create databases and roles. Chirp creates dedicated
									databases for this board.
								</p>
								{!postgresAvailable ? (
									<p role="status" className="m-0 text-[13.5px] leading-[1.5] text-danger">
										PostgreSQL setup is not available on this Cloud instance yet. Choose managed SQLite or contact your
										administrator.
									</p>
								) : null}
							</div>
						) : (
							<p className={hint}>Chirp provisions your board and persistent storage automatically.</p>
						)}
						{error ? (
							<p
								role="alert"
								className="m-0 rounded-xl bg-danger/6 px-4 py-3 text-[13.5px] leading-[1.5] text-danger ring-1 ring-danger/20"
							>
								{error}
							</p>
						) : null}
					</div>
					<DialogFooter className="border-t border-rule px-6 py-4">
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
							{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
							{pending ? "Creating board…" : "Create board"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
