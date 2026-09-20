"use client";

import { Schema } from "effect";
import { useEffect, useState } from "react";
import { InvitationToken } from "../../invitation-token.ts";
import { AuthButtons } from "../auth-buttons.tsx";

export function InvitationPage() {
	const [token, setToken] = useState<InvitationToken | null>();

	useEffect(() => {
		const value = globalThis.location.hash.slice(1);
		setToken(Schema.is(InvitationToken)(value) ? value : null);
		globalThis.history.replaceState(null, "", "/invite");
	}, []);

	return (
		<main className="auth-main">
			<section className="auth-card">
				<p className="eyebrow">You’re invited</p>
				<h1>{token === null ? "This invitation link is invalid." : "Create your Chirp Cloud account."}</h1>
				<p className="lede">
					{token === null
						? "Ask the operator for a new invitation."
						: "Use the verified email address this invitation was sent to."}
				</p>
				{token ? <AuthButtons invitation={token} /> : null}
			</section>
		</main>
	);
}
