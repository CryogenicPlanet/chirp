"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { Effect } from "effect";
import { useMemo, useState } from "react";
import { ChevronsUpDown, KeyRound, LogOut, UserRound } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import type { OAuthProvider } from "../auth-settings.ts";
import type { InvitationToken } from "../invitation-token.ts";
import { track } from "./analytics.ts";

interface AuthButtonsProps {
	readonly providers?: ReadonlyArray<OAuthProvider>;
	readonly invitation?: InvitationToken;
	readonly user?: { readonly name: string; readonly email: string };
}

export function AuthButtons({ invitation, user, providers = [] }: AuthButtonsProps) {
	const auth = useMemo(() => createAuthClient({ plugins: [passkeyClient()] }), []);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [pending, setPending] = useState(false);
	const [accountOpen, setAccountOpen] = useState(false);
	const social = (provider: "github" | "google") => {
		setPending(true);
		setError(undefined);
		setNotice(undefined);
		track("sign_in_started", { method: provider, invited: invitation !== undefined });
		Effect.tryPromise(() =>
			auth.signIn.social({
				provider,
				callbackURL: "/",
				requestSignUp: invitation !== undefined,
				additionalData: invitation ? { invitation } : undefined,
			}),
		).pipe(
			Effect.tap((result) =>
				result.error ? Effect.sync(() => setError(result.error.message ?? "Sign-in failed")) : Effect.void,
			),
			Effect.catch(() => Effect.sync(() => setError("Sign-in is temporarily unavailable"))),
			Effect.ensuring(Effect.sync(() => setPending(false))),
			Effect.runFork,
		);
	};
	const passkey = () => {
		setPending(true);
		setError(undefined);
		setNotice(undefined);
		track("sign_in_started", { method: "passkey", invited: false });
		Effect.tryPromise(() => auth.signIn.passkey()).pipe(
			Effect.tap((result) =>
				result?.error
					? Effect.sync(() => setError(result.error.message ?? "Passkey sign-in failed"))
					: Effect.sync(() => window.location.assign("/")),
			),
			Effect.catch(() => Effect.sync(() => setError("Passkey sign-in is temporarily unavailable"))),
			Effect.ensuring(Effect.sync(() => setPending(false))),
			Effect.runFork,
		);
	};
	const enrollPasskey = () => {
		setPending(true);
		setError(undefined);
		setNotice(undefined);
		Effect.tryPromise(() => auth.passkey.addPasskey({ name: "Chirp Cloud passkey" })).pipe(
			Effect.tap((result) =>
				result.error
					? Effect.sync(() => setError(result.error.message ?? "Passkey enrollment failed"))
					: Effect.sync(() => setNotice("Passkey added. You can use it the next time you sign in.")),
			),
			Effect.catch(() => Effect.sync(() => setError("Passkey enrollment is temporarily unavailable"))),
			Effect.ensuring(Effect.sync(() => setPending(false))),
			Effect.runFork,
		);
	};
	const signOut = () => {
		setPending(true);
		setError(undefined);
		setNotice(undefined);
		Effect.tryPromise(() => auth.signOut()).pipe(
			Effect.tap((result) =>
				result.error
					? Effect.sync(() => setError(result.error.message ?? "Sign-out failed"))
					: Effect.sync(() => window.location.assign("/")),
			),
			Effect.catch(() => Effect.sync(() => setError("Sign-out is temporarily unavailable"))),
			Effect.ensuring(Effect.sync(() => setPending(false))),
			Effect.runFork,
		);
	};
	if (user)
		return (
			<>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" className="h-auto w-full justify-start px-2 py-2.5">
							<span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-primary">
								<UserRound className="size-4" />
							</span>
							<span className="grid min-w-0 gap-0.5 text-left">
								<span className="truncate text-xs font-medium">{user.name}</span>
								<span className="truncate text-[11px] font-normal text-muted-foreground">{user.email}</span>
							</span>
							<ChevronsUpDown className="ml-auto size-3.5 text-subtle" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="top" align="start" className="w-60">
						<DropdownMenuLabel className="text-xs text-muted-foreground">Your account</DropdownMenuLabel>
						<DropdownMenuItem onSelect={() => setAccountOpen(true)}>
							<KeyRound />
							Security & passkeys
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem disabled={pending} onSelect={signOut}>
							<LogOut />
							{pending ? "Signing out…" : "Sign out"}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Dialog open={accountOpen} onOpenChange={setAccountOpen}>
					<DialogContent className="bg-card">
						<DialogHeader className="text-left">
							<DialogTitle>Security & passkeys</DialogTitle>
							<DialogDescription>Add a passkey for a quick, secure way to sign in to Chirp Cloud.</DialogDescription>
						</DialogHeader>
						<div className="flex items-center justify-between gap-4 rounded-lg border p-4">
							<div>
								<p className="font-medium">Sign in with a passkey</p>
								<p className="mt-1 text-xs text-muted-foreground">Use your fingerprint, face, or security key.</p>
							</div>
							<Button variant="outline" disabled={pending} onClick={enrollPasskey}>
								<KeyRound />
								{pending ? "Adding…" : "Add passkey"}
							</Button>
						</div>
						{notice ? (
							<p role="status" className="text-xs text-primary">
								{notice}
							</p>
						) : null}
						{error ? (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						) : null}
					</DialogContent>
				</Dialog>
				{!accountOpen && error ? (
					<p role="alert" className="mt-2 text-xs text-destructive">
						{error}
					</p>
				) : null}
			</>
		);

	return (
		<div className="grid min-w-0 gap-2">
			{providers.map((provider) => (
				<button
					className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground hover:not-disabled:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
					disabled={pending}
					key={provider}
					onClick={() => social(provider)}
					type="button"
				>
					Continue with {provider === "github" ? "GitHub" : "Google"}
				</button>
			))}
			{invitation ? null : (
				<button
					className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-3.5 py-2 text-[13px] font-medium leading-none text-foreground hover:not-disabled:border-primary hover:not-disabled:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
					disabled={pending}
					onClick={passkey}
					type="button"
				>
					Sign in with a passkey
				</button>
			)}
			{error ? (
				<p aria-live="polite" className="mt-1 text-xs leading-[1.45] text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}
