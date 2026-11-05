import type { TopicMutation } from "@comms/protocol";
import * as Dialog from "@radix-ui/react-dialog";
import { Effect, Schema } from "effect";
import { Archive, ArchiveRestore, ChevronRight, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { BoardError } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { cn } from "./cn.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Input, Textarea } from "./ui/input.tsx";

const text = (value: unknown) => (typeof value === "string" ? value : "");

function Switch({
	checked,
	disabled,
	onChange,
	id,
	describedBy,
}: {
	readonly checked: boolean;
	readonly disabled: boolean;
	readonly onChange: (checked: boolean) => void;
	readonly id: string;
	readonly describedBy: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			id={id}
			aria-checked={checked}
			aria-describedby={describedBy}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50",
				checked ? "bg-ink" : "bg-edge/60",
			)}
		>
			<span
				className={cn(
					"size-5 rounded-full bg-white shadow-sm transition-transform",
					checked ? "translate-x-[18px]" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}

function Row({
	label,
	description,
	htmlFor,
	descriptionId,
	children,
}: {
	readonly label: string;
	readonly description: ReactNode;
	readonly htmlFor: string;
	readonly descriptionId: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-6 py-4">
			<div className="min-w-0">
				<label htmlFor={htmlFor} className="text-[14.5px] font-medium text-ink">
					{label}
				</label>
				<p id={descriptionId} className="mt-0.5 text-[13px] leading-relaxed text-slate">
					{description}
				</p>
			</div>
			{children}
		</div>
	);
}

interface SettingsProps {
	readonly path: string;
	readonly meta: Schema.JsonObject;
	readonly archived: boolean;
	readonly parentArchived?: boolean;
	readonly onSaved: (topic: typeof TopicMutation.Type) => void;
}

/** Topic details in plain fields, with raw metadata under Advanced and archiving set apart. */
export function TopicSettings({
	open,
	onOpenChange,
	...props
}: SettingsProps & { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
				<Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(460px,100vw)] flex-col bg-paper shadow-float outline-none data-[state=open]:animate-[sheet-in_220ms_cubic-bezier(0.32,0.72,0,1)]">
					{/* Content unmounts when closed, so each opening starts from the saved metadata. */}
					<SettingsBody {...props} />
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function SettingsBody({ path, meta, archived, parentArchived = false, onSaved }: SettingsProps) {
	const { saveTopic } = useBoardClient();
	const id = useId();
	const [description, setDescription] = useState(() => text(meta.description));
	const [status, setStatus] = useState(() => text(meta.status));
	const [draft, setDraft] = useState(() => JSON.stringify(meta, null, 2));
	const [advanced, setAdvanced] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const [busy, setBusy] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [error, setError] = useState<BoardError | null>(null);
	const disabled = busy || uncertain || parentArchived;
	const locked = disabled || archived;
	const mutate = (input: { readonly meta: Schema.JsonObject } | { readonly archived: boolean }, done: string) => {
		if (disabled) return;
		setBusy(true);
		setError(null);
		void Effect.runPromise(saveTopic(path, input).pipe(Effect.result)).then((result) => {
			setBusy(false);
			if (result._tag === "Failure") {
				setError(result.failure);
				setUncertain(result.failure.status === 0 || result.failure.status >= 500 || result.failure.status === 408);
				return;
			}
			setDraft(JSON.stringify(result.success.meta, null, 2));
			setDescription(text(result.success.meta.description));
			setStatus(text(result.success.meta.status));
			toast.success(done);
			onSaved(result.success);
		});
	};
	// Metadata replaces the whole object: keep keys these fields do not own.
	const withField = (key: string, value: string | boolean): Schema.JsonObject => {
		const { [key]: _removed, ...rest } = meta;
		return value === "" || value === false ? rest : { ...rest, [key]: value };
	};
	const dirty = description !== text(meta.description) || status !== text(meta.status);
	const isPublic = meta.public === true;
	return (
		<>
			<header className="flex items-start justify-between gap-4 border-b border-rule px-6 pt-6 pb-5">
				<div className="min-w-0">
					<Dialog.Title className="text-[19px] font-semibold tracking-[-0.02em]">Topic settings</Dialog.Title>
					<Dialog.Description className="mt-1 truncate text-[13.5px] text-slate">#{path}</Dialog.Description>
				</div>
				<Dialog.Close asChild>
					<Button variant="ghost" size="icon" className="-mt-1 -mr-2 size-9" aria-label="Close settings">
						<X />
					</Button>
				</Dialog.Close>
			</header>
			<div className="flex-1 overflow-y-auto px-6 pb-8">
				{(archived || parentArchived) && (
					<Alert className="mt-5">
						{parentArchived
							? "A parent topic is archived. Unarchive it before changing this topic."
							: "This topic is archived and read-only. Unarchive it to edit or post."}
					</Alert>
				)}
				<form
					className="pt-5"
					onSubmit={(event) => {
						event.preventDefault();
						if (locked || !dirty) return;
						const { description: _description, status: _status, ...rest } = meta;
						mutate(
							{
								meta: {
									...rest,
									...(description.trim() ? { description: description.trim() } : {}),
									...(status.trim() ? { status: status.trim() } : {}),
								},
							},
							"Topic details saved",
						);
					}}
				>
					<label htmlFor={`${id}-description`} className="text-[14.5px] font-medium">
						Description
					</label>
					<p className="mt-0.5 mb-2 text-[13px] text-slate">Shown under the topic name and in topic lists.</p>
					<Textarea
						id={`${id}-description`}
						rows={2}
						value={description}
						disabled={locked}
						placeholder="What this topic is for"
						onChange={(event) => setDescription(event.target.value)}
					/>
					<label htmlFor={`${id}-status`} className="mt-5 block text-[14.5px] font-medium">
						Status
					</label>
					<p className="mt-0.5 mb-2 text-[13px] text-slate">
						A short note on where things stand, like “doing” or “blocked”.
					</p>
					<Input
						id={`${id}-status`}
						value={status}
						disabled={locked}
						placeholder="No status"
						onChange={(event) => setStatus(event.target.value)}
					/>
					<div className="mt-4 flex justify-end">
						<Button type="submit" size="sm" disabled={locked || !dirty}>
							{busy ? "Saving…" : "Save details"}
						</Button>
					</div>
				</form>
				<div className="mt-6 border-t border-rule">
					<Row
						label="Public pages"
						description="Anyone with a link can read the pages in this topic’s folder, without signing in. Messages and subtopic pages stay private."
						htmlFor={`${id}-public`}
						descriptionId={`${id}-public-hint`}
					>
						<Switch
							id={`${id}-public`}
							describedBy={`${id}-public-hint`}
							checked={isPublic}
							disabled={locked}
							onChange={(checked) =>
								mutate({ meta: withField("public", checked) }, checked ? "Pages are public" : "Pages are private")
							}
						/>
					</Row>
				</div>
				<div className="border-t border-rule">
					<button
						type="button"
						aria-expanded={advanced}
						onClick={() => setAdvanced((value) => !value)}
						className="flex w-full cursor-pointer items-center gap-1.5 py-4 text-[14px] font-medium text-ink-soft hover:text-ink"
					>
						<ChevronRight className={cn("size-4 transition-transform", advanced && "rotate-90")} />
						Advanced: raw metadata
					</button>
					{advanced && (
						<form
							className="pb-4"
							onSubmit={(event) => {
								event.preventDefault();
								if (locked) return;
								const parsed = Schema.decodeResult(Schema.fromJsonString(Schema.JsonObject))(draft);
								if (parsed._tag === "Failure") {
									setInvalid(true);
									return;
								}
								setInvalid(false);
								mutate({ meta: parsed.success }, "Metadata saved");
							}}
						>
							<p className="mb-2 text-[13px] leading-relaxed text-slate" id={`${id}-json-hint`}>
								Agents can store their own keys here. Saving replaces all metadata.
							</p>
							<Textarea
								className="min-h-[160px] font-mono text-[13px]"
								aria-label="Metadata JSON"
								aria-describedby={`${id}-json-hint`}
								aria-invalid={invalid}
								spellCheck={false}
								value={draft}
								disabled={locked}
								onChange={(event) => {
									setDraft(event.target.value);
									setInvalid(false);
								}}
							/>
							{invalid && (
								<p className="mt-2 text-[13px] text-danger" role="alert">
									Enter a valid JSON object, such as {`{"status":"doing"}`}.
								</p>
							)}
							<Button className="mt-3" variant="outline" size="sm" type="submit" disabled={locked}>
								Save metadata
							</Button>
						</form>
					)}
				</div>
				<section className="mt-4 rounded-xl p-4 ring-1 ring-danger/30" aria-label="Archive">
					<div className="flex items-center justify-between gap-4">
						<div>
							<h3 className="text-[14.5px] font-medium">{archived ? "Unarchive topic" : "Archive topic"}</h3>
							<p className="mt-0.5 text-[13px] leading-relaxed text-slate">
								{archived
									? "Makes it writable again and brings back unread counts."
									: "Makes it and its subtopics read-only and hides them from unread counts. You can undo this."}
							</p>
						</div>
						<Button
							variant={archived ? "outline" : "destructive"}
							size="sm"
							type="button"
							disabled={disabled}
							onClick={() => mutate({ archived: !archived }, archived ? "Topic unarchived" : "Topic archived")}
						>
							{archived ? <ArchiveRestore /> : <Archive />}
							{archived ? "Unarchive" : "Archive"}
						</Button>
					</div>
				</section>
				{error && (
					<Alert className="mt-4">
						<p>{error.message}</p>
						{error.status === 401 && (
							<a href="/auth/login" target="_blank" rel="noreferrer">
								Sign in with a passkey, then try again
							</a>
						)}
						{uncertain && (
							<>
								<p>The change may have saved. Reload and check this topic before making another change.</p>
								<Button variant="outline" size="sm" type="button" onClick={() => window.location.reload()}>
									Reload topic
								</Button>
							</>
						)}
					</Alert>
				)}
			</div>
		</>
	);
}
