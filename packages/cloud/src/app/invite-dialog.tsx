"use client";

import { Schema } from "effect";
import { Check, Copy, Loader2, UserPlus } from "lucide-react";
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
import { useTrack } from "./analytics.tsx";

const invitationResponse = Schema.Struct({ url: Schema.String, expires_at: Schema.String });
const permissionResponse = Schema.Struct({ can_invite: Schema.Boolean });

export function InviteDialog() {
	const track = useTrack();
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
				<Button variant="ghost" className="w-full justify-start px-2.5 hover:bg-card">
					<UserPlus />
					Invite someone
				</Button>
			</DialogTrigger>
			<DialogContent showCloseButton={!pending}>
				<DialogHeader className="text-left">
					<DialogTitle>Invite someone to Chirp Cloud</DialogTitle>
					<DialogDescription>
						Give someone a space for their own boards. This won't grant access to yours.
					</DialogDescription>
				</DialogHeader>
				{invitation ? (
					<div className="grid gap-4">
						<p className="m-0 flex items-center gap-2 font-medium text-leaf">
							<Check aria-hidden="true" className="size-4" />
							Your invitation is ready
						</p>
						<p className="m-0 text-[13.5px] leading-[1.55] text-slate">
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
						<p className="m-0 text-[13.5px] text-slate">No email has been sent.</p>
					</div>
				) : (
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							void generate(event);
						}}
					>
						<p className="m-0 text-[14.5px] leading-[1.55] text-slate">
							Anyone with the link can join by signing in. Each link works once and expires after 24 hours.
						</p>
						<Button disabled={pending} type="submit">
							{pending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <UserPlus />}
							{pending ? "Creating invitation…" : "Generate invitation"}
						</Button>
					</form>
				)}
				{error ? (
					<p role="alert" className="m-0 text-[13.5px] leading-[1.5] text-danger">
						{error}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
