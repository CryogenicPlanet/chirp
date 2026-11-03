"use client";

import { Schema } from "effect";
import { useEffect, useState } from "react";
import type { OAuthProvider } from "../../auth-settings.ts";
import { InvitationToken } from "../../invitation-token.ts";
import { useAnalyticsIdentity } from "../analytics.tsx";
import { AuthButtons } from "../auth-buttons.tsx";
import { EntryScreen, entryLede, entryTitle } from "../entry-screen.tsx";

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
		<EntryScreen labelledBy="invitation-title">
			<h1 className={entryTitle} id="invitation-title">
				{token === null ? "This invitation link is invalid." : "You’re invited to Chirp Cloud."}
			</h1>
			<p className={entryLede}>
				{token === null ? "Ask the operator for a new invitation." : "Sign in to create your account."}
			</p>
			{authUnavailable ? (
				<p role="alert" className="m-0 text-[14px] leading-[1.5] text-danger">
					Authentication is temporarily unavailable. Try opening your invitation again later.
				</p>
			) : token ? (
				<AuthButtons invitation={token} providers={providers} />
			) : null}
		</EntryScreen>
	);
}
