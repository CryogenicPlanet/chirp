"use client";

import { Schema } from "effect";
import { Check, Copy, Link2, Loader2, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./components/ui/dialog.tsx";
import { Input } from "./components/ui/input.tsx";
import { track } from "./analytics.tsx";

const invitationResponse = Schema.Struct({ url: Schema.String, expires_at: Schema.String });
const permissionResponse = Schema.Struct({ can_invite: Schema.Boolean });

export function InviteDialog() {
	const [allowed, setAllowed] = useState(false);
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const [invitation, setInvitation] = useState<typeof invitationResponse.Type>();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		void fetch("/api/invitations", { signal: controller.signal, cache: "no-store" })
			.then(async (response) => {
				if (response.ok) setAllowed(Schema.decodeUnknownSync(permissionResponse)(await response.json()).can_invite);
			})
			.catch(() => {});
		return () => controller.abort();
	}, []);
	const generate = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		setPending(true);
		setError(undefined);
		try {
			const response = await fetch("/api/invitations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			if (!response.ok) {
				setError(
					response.status === 401
						? "Your session expired. Sign in again to create an invitation."
						: response.status === 429
							? "You’ve created several invitations recently. Please wait before trying again."
							: response.status === 403
								? "Your account cannot create invitations. Contact your Cloud administrator."
								: "We couldn't create the invitation. Please try again.",
				);
				return;
			}
			setInvitation(Schema.decodeUnknownSync(invitationResponse)(await response.json()));
			track("invitation_created");
		} catch {
			setError("We couldn't create the invitation. Check your connection and try again.");
		} finally {
			setPending(false);
		}
	};
	const copy = async () => {
		if (!invitation) return;
		try {
			await navigator.clipboard.writeText(invitation.url);
			setCopied(true);
		} catch {
			setError("Couldn't copy automatically. Select and copy the link below.");
		}
	};
	if (!allowed) return null;
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!pending) {
					setOpen(value);
					if (!value) {
						setInvitation(undefined);
						setCopied(false);
						setError(undefined);
					}
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="ghost" className="w-full justify-start text-muted-foreground">
					<UserPlus />
					Invite someone
				</Button>
			</DialogTrigger>
			<DialogContent className="bg-card" showCloseButton={!pending}>
				<DialogHeader className="text-left">
					<div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
						<Link2 className="size-5" />
					</div>
					<DialogTitle>Invite someone to Chirp Cloud</DialogTitle>
					<DialogDescription>
						Give someone a space for their own boards. This won't grant access to yours.
					</DialogDescription>
				</DialogHeader>
				{invitation ? (
					<div className="grid gap-4">
						<p className="flex items-center gap-2 text-primary">
							<Check className="size-4" />
							Your invitation is ready
						</p>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Send this link to your invitee. It can be used once and expires{" "}
							{new Date(invitation.expires_at).toLocaleString()}.
						</p>
						<label className="sr-only" htmlFor="invitation-link">
							Invitation link
						</label>
						<Input
							id="invitation-link"
							readOnly
							value={invitation.url}
							onFocus={(event) => event.currentTarget.select()}
						/>
						<Button
							onClick={() => {
								void copy();
							}}
						>
							{copied ? <Check /> : <Copy />}
							{copied ? "Copied" : "Copy invitation link"}
						</Button>
						<p className="text-xs text-muted-foreground">No email has been sent.</p>
					</div>
				) : (
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							void generate(event);
						}}
					>
						<p className="text-sm leading-relaxed text-muted-foreground">
							Anyone with the link can join by signing in. Each link works once and expires after 24 hours.
						</p>
						<Button disabled={pending} type="submit">
							{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <UserPlus />}
							{pending ? "Creating invitation…" : "Generate invitation"}
						</Button>
					</form>
				)}
				{error ? (
					<p role="alert" className="text-xs leading-relaxed text-destructive">
						{error}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
