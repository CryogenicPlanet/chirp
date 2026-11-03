import type { Metadata } from "next";
import Link from "next/link";
import { SignedOutAnalytics } from "../../analytics.tsx";
import { buttonVariants } from "../../components/ui/button.tsx";
import { EntryScreen, entryLede, entryTitle } from "../../entry-screen.tsx";

export const metadata: Metadata = { title: "Sign-in help · Chirp Cloud" };

export default async function AuthErrorPage({
	searchParams,
}: {
	readonly searchParams: Promise<{ readonly error?: string | string[] }>;
}) {
	const { error } = await searchParams;
	const invitationRequired = error === "signup_disabled" || error === "invitation_required";
	const invitationInvalid = error === "invitation_invalid";
	const title = invitationRequired
		? "You need an invitation"
		: invitationInvalid
			? "We couldn’t accept this invitation"
			: "We couldn’t sign you in";
	const description = invitationRequired
		? "Chirp Cloud is invite-only. Open your invitation link to create an account."
		: invitationInvalid
			? "This invitation has expired, was already used, or isn't valid for this account. Ask for a new link."
			: "Your sign-in didn’t finish. Return to sign in and try again. If you’re creating an account, start from your invitation link.";

	return (
		<EntryScreen labelledBy="auth-error-title">
			<SignedOutAnalytics />
			<h1 className={entryTitle} id="auth-error-title">
				{title}
			</h1>
			<p className={entryLede}>{description}</p>
			<Link className={`${buttonVariants()} w-full no-underline`} href="/">
				Back to sign in
			</Link>
			{invitationRequired || invitationInvalid ? (
				<p className="mt-4 mb-0 text-[13.5px] leading-[1.55] text-slate">
					Already have an account? Sign in with the account you used before.
				</p>
			) : null}
		</EntryScreen>
	);
}
