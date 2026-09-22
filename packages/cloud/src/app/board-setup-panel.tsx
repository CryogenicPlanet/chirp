"use client";

import { Schema } from "effect";
import { ArrowUpRight, Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

const setupResponse = Schema.Struct({ code: Schema.String, expires_at: Schema.String, onboarding_url: Schema.String });
const setupError = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });

export function BoardSetupPanel({ boardId, hostname }: { readonly boardId: string; readonly hostname: string }) {
	const [issued, setIssued] = useState<typeof setupResponse.Type>();
	const [pending, setPending] = useState(false);
	const [copied, setCopied] = useState(false);
	const [expired, setExpired] = useState(false);
	const [closed, setClosed] = useState(false);
	const [error, setError] = useState<string>();
	const request = useRef<AbortController | null>(null);
	const codeField = useRef<HTMLInputElement>(null);

	useEffect(() => () => request.current?.abort(), []);
	useEffect(() => {
		if (!issued) return;
		const expire = () => {
			setIssued(undefined);
			setCopied(false);
			setExpired(true);
		};
		const remaining = Date.parse(issued.expires_at) - Date.now();
		if (remaining <= 0) {
			expire();
			return;
		}
		const timer = window.setTimeout(expire, remaining);
		return () => window.clearTimeout(timer);
	}, [issued]);

	const copy = async (code: string, signal?: AbortSignal) => {
		try {
			await navigator.clipboard.writeText(code);
			if (!signal?.aborted) setCopied(true);
		} catch {
			if (signal?.aborted) return;
			setCopied(false);
			setError("Your code is ready. Select and copy it below, or try Copy again.");
			codeField.current?.focus();
			codeField.current?.select();
		}
	};

	const generate = async () => {
		if (request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setPending(true);
		setIssued(undefined);
		setCopied(false);
		setError(undefined);
		try {
			const response = await fetch(`/api/boards/${encodeURIComponent(boardId)}/setup-code`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
				cache: "no-store",
				signal: controller.signal,
			});
			if (!response.ok) {
				const failure = Schema.decodeUnknownSync(setupError)(await response.json());
				if (failure.error.code === "setup_closed") setClosed(true);
				else
					setError(
						failure.error.code === "setup_code_unsupported"
							? "This board needs a newer Chirp image before Cloud can generate setup codes. Contact your Cloud administrator."
							: response.status === 401
								? "Your session expired. Sign in to Cloud again to get a setup code."
								: response.status === 429
									? "Please wait a moment before generating another code."
									: "We couldn't generate a setup code. Check that your board is running and try again.",
					);
				return;
			}
			const value = Schema.decodeUnknownSync(setupResponse)(await response.json());
			if (
				value.onboarding_url !== `https://${hostname}/onboarding` ||
				!value.code ||
				!Number.isFinite(Date.parse(value.expires_at)) ||
				Date.parse(value.expires_at) <= Date.now()
			) {
				setError("We couldn't verify the setup code. Please try again.");
				return;
			}
			setIssued(value);
			setExpired(false);
			await copy(value.code, controller.signal);
		} catch {
			if (!controller.signal.aborted) setError("We couldn't reach your board. Check your connection and try again.");
		} finally {
			if (!controller.signal.aborted) setPending(false);
			request.current = null;
		}
	};

	return (
		<details className="mt-4 rounded-md border border-border bg-card p-5">
			<summary className="cursor-pointer text-sm font-medium focus-visible:outline-ring">
				{closed ? "Board passkey is set up" : "First-time board setup"}
			</summary>
			<div className="pt-3">
				<h2 id="board-setup" className="mt-2 mb-0 text-xl font-normal tracking-tight">
					{closed ? "Your board is already set up" : "Add your first passkey"}
				</h2>
				<p className="mt-2 mb-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
					{closed
						? "Sign in to your board with its passkey to continue."
						: "Already have a board passkey? Use Open board to sign in. Otherwise, copy a private setup code to add your first passkey. The code is valid for 15 minutes."}
				</p>
				{closed ? (
					<Button asChild>
						<a href={`https://${hostname}`} target="_blank" rel="noreferrer">
							Sign in to board <ArrowUpRight />
						</a>
					</Button>
				) : (
					<div className="grid gap-3">
						{issued ? (
							<div className="max-w-lg">
								<label htmlFor="board-setup-code" className="mb-2 block text-xs font-medium">
									Your private setup code
								</label>
								<div className="flex gap-2">
									<Input
										id="board-setup-code"
										ref={codeField}
										readOnly
										value={issued.code}
										autoComplete="off"
										spellCheck={false}
										className="font-mono"
										onFocus={(event) => event.currentTarget.select()}
									/>
									<Button
										variant="outline"
										onClick={() => {
											setError(undefined);
											void copy(issued.code);
										}}
									>
										<Copy />
										Copy
									</Button>
								</div>
								<p className="mt-2 mb-0 text-xs text-muted-foreground">
									Expires at{" "}
									{new Date(issued.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Keep it
									private.
								</p>
							</div>
						) : null}
						{expired && !issued ? (
							<p role="status" className="m-0 text-sm text-muted-foreground">
								Your setup code expired. Generate a new one to continue.
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={pending}
								variant="outline"
								onClick={() => {
									void generate();
								}}
							>
								{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Copy />}
								{pending ? "Generating code…" : issued || expired ? "Generate new code" : "Copy setup code"}
							</Button>
							{issued ? (
								<Button asChild>
									<a href={issued.onboarding_url} target="_blank" rel="noreferrer">
										Continue to onboarding <ArrowUpRight />
									</a>
								</Button>
							) : null}
						</div>
						{copied ? (
							<p role="status" className="m-0 flex items-center gap-1.5 text-xs text-primary">
								<Check className="size-3.5" />
								Code copied. Paste it on the onboarding page.
							</p>
						) : null}
						{error ? (
							<p role="alert" className="m-0 text-sm text-destructive">
								{error}
							</p>
						) : null}
					</div>
				)}
			</div>
		</details>
	);
}
