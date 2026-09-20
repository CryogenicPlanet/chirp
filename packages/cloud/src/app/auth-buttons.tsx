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
			<div className="auth-actions">
				<div className="account-summary">
					<strong>{user.name}</strong>
					<span>{user.email}</span>
				</div>
				<button disabled={pending} onClick={enrollPasskey} type="button">
					Add a passkey
				</button>
				<button className="secondary" disabled={pending} onClick={signOut} type="button">
					Sign out
				</button>
				{notice ? (
					<p aria-live="polite" className="notice">
						{notice}
					</p>
				) : null}
				{error ? (
					<p aria-live="polite" className="error">
						{error}
					</p>
				) : null}
			</div>
		);
	return (
		<div className="auth-actions">
			<button disabled={pending} onClick={() => social("github")} type="button">
				Continue with GitHub
			</button>
			<button disabled={pending} onClick={() => social("google")} type="button">
				Continue with Google
			</button>
			{invitation ? null : (
				<button className="secondary" disabled={pending} onClick={passkey} type="button">
					Sign in with a passkey
				</button>
			)}
			{error ? (
				<p aria-live="polite" className="error">
					{error}
				</p>
			) : null}
		</div>
	);
}
