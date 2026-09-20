import { AuthButtons } from "../../auth-buttons.tsx";
import { InvitationToken } from "../../../invitation-token.ts";
import { Schema } from "effect";
import { notFound } from "next/navigation";
import { use } from "react";

export default function InvitationPage({ params }: { readonly params: Promise<{ readonly token: string }> }) {
	const { token } = use(params);
	if (!Schema.is(InvitationToken)(token)) notFound();
	return (
		<main>
			<section className="auth-card">
				<p className="eyebrow">You’re invited</p>
				<h1>Create your Chirp Cloud account.</h1>
				<p className="lede">Use the verified email address this invitation was sent to.</p>
				<AuthButtons invitation={token} />
			</section>
		</main>
	);
}
