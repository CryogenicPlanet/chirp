"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { Effect } from "effect";
import { useMemo, useState } from "react";
import type { InvitationToken } from "../invitation-token.ts";

interface AuthButtonsProps {
	readonly invitation?: InvitationToken;
	readonly user?: { readonly name: string; readonly email: string };
}

export const createCloudAuthClient = () => createAuthClient({ plugins: [passkeyClient()] });

export function AuthButtons({ invitation, user }: AuthButtonsProps) {
	const auth = useMemo(createCloudAuthClient, []);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [pending, setPending] = useState(false);
	const social = (provider: "github" | "google") => {
		setPending(true);
		setError(undefined);
		setNotice(undefined);
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
		Effect.tryPromise(() => auth.signIn.passkey()).pipe(
			Effect.tap((result) =>
				result?.error ? Effect.sync(() => setError(result.error.message ?? "Passkey sign-in failed")) : Effect.void,
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
			<div className="grid min-w-0 gap-2">
				<div className="mb-1.5 grid min-w-0 gap-0.5">
					<strong className="text-[13px] font-medium">{user.name}</strong>
					<span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{user.email}</span>
				</div>
				<button
					className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground hover:not-disabled:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
					disabled={pending}
					onClick={enrollPasskey}
					type="button"
				>
					Add a passkey
				</button>
				<button
					className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-input bg-card px-3.5 py-2 text-[13px] font-medium leading-none text-foreground hover:not-disabled:border-primary hover:not-disabled:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
					disabled={pending}
					onClick={signOut}
					type="button"
				>
					Sign out
				</button>
				{notice ? (
					<p aria-live="polite" className="mt-1 text-xs leading-[1.45] text-primary">
						{notice}
					</p>
				) : null}
				{error ? (
					<p aria-live="polite" className="mt-1 text-xs leading-[1.45] text-destructive">
						{error}
					</p>
				) : null}
			</div>
		);
	return (
		<div className="grid min-w-0 gap-2">
			<button
				className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground hover:not-disabled:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
				disabled={pending}
				onClick={() => social("github")}
				type="button"
			>
				Continue with GitHub
			</button>
			<button
				className="inline-flex min-h-9 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground hover:not-disabled:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-55"
				disabled={pending}
				onClick={() => social("google")}
				type="button"
			>
				Continue with Google
			</button>
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
