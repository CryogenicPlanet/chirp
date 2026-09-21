import type { Metadata } from "next";
import Link from "next/link";

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
		<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
			<section
				aria-labelledby="auth-error-title"
				className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6"
			>
				<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">Chirp Cloud</p>
				<h1
					className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance"
					id="auth-error-title"
				>
					{title}
				</h1>
				<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">{description}</p>
				<Link
					className="inline-flex min-h-9 w-full items-center justify-center rounded-md border border-transparent bg-primary px-3.5 py-2 text-[13px] font-medium leading-none text-primary-foreground no-underline hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					href="/"
				>
					Back to sign in
				</Link>
				{invitationRequired || invitationInvalid ? (
					<p className="mt-4 mb-0 text-xs leading-[1.55] text-subtle">
						Already have an account? Sign in with the account you used before.
					</p>
				) : null}
			</section>
		</main>
	);
}
