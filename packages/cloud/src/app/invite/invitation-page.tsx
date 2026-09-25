"use client";

import { Schema } from "effect";
import { useEffect, useState } from "react";
import type { OAuthProvider } from "../../auth-settings.ts";
import { InvitationToken } from "../../invitation-token.ts";
import { useAnalyticsIdentity } from "../analytics.ts";
import { AuthButtons } from "../auth-buttons.tsx";

export function InvitationPage({
	providers,
	authUnavailable = false,
}: {
	readonly providers: ReadonlyArray<OAuthProvider>;
	readonly authUnavailable?: boolean;
}) {
	const [token, setToken] = useState<InvitationToken | null>();
	// An invitation creates a new account, so it never continues a previous account's identity.
	useAnalyticsIdentity(null);

	useEffect(() => {
		const value = globalThis.location.hash.slice(1);
		// Preserve the first read when Strict Mode replays this effect after fragment cleanup.
		setToken((current) => (current === undefined ? (Schema.is(InvitationToken)(value) ? value : null) : current));
		globalThis.history.replaceState(null, "", "/invite");
	}, []);

	return (
		<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
			<section className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6">
				<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">You’re invited</p>
				<h1 className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance">
					{token === null ? "This invitation link is invalid." : "Create your Chirp Cloud account."}
				</h1>
				<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">
					{token === null ? "Ask the operator for a new invitation." : "Sign in to join Chirp Cloud."}
				</p>
				{authUnavailable ? (
					<p role="alert" className="text-xs text-destructive">
						Authentication is temporarily unavailable. Try opening your invitation again later.
					</p>
				) : token ? (
					<AuthButtons invitation={token} providers={providers} />
				) : null}
			</section>
		</main>
	);
}
