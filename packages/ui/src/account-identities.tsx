import { useLoad } from "./use-load.ts";
import { Effect } from "effect";
import { useState } from "react";
import { type BoardError } from "./board-api.ts";
import { confirmLink, getIdentities, startLink, unlinkIdentity, type Provider } from "./account-identities-api.ts";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";

const names = { github: "GitHub", google: "Google" } as const satisfies Record<Provider, string>;

/** GitHub and Google accounts that sign in like a passkey. Linking and unlinking each need the passkey. */
export function AccountIdentities() {
	const { value: identities, error: loadError, reload } = useLoad(getIdentities);
	const [error, setError] = useState<BoardError | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const run = (operation: Effect.Effect<void, BoardError>, waiting: string, success: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		setMessage(waiting);
		void Effect.runPromise(operation.pipe(Effect.result)).then((result) => {
			setBusy(false);
			reload();
			if (result._tag === "Failure") {
				setError(result.failure);
				setMessage("");
			} else setMessage(success);
		});
	};
	// Boot returns here with ?link=<id> after the issuer; the link waits for the passkey below.
	const linked = () => {
		const url = new URL(window.location.href);
		url.searchParams.delete("link");
		window.history.replaceState(null, "", url.pathname + url.search + url.hash);
	};
	const pending = identities?.pending;
	// One account per provider here: a provider that already signs in is not offered again.
	const linkable =
		identities?.providers.filter(
			(provider) => !identities.identities.some((identity) => identity.active && identity.provider === provider),
		) ?? [];
	return (
		<section className="mt-8 text-[13px]" aria-labelledby="account-identities-heading">
			<SectionHeading title={<span id="account-identities-heading">GitHub and Google sign-in</span>} />
			{identities?.identities.map((identity) => (
				<article className="flex items-center justify-between gap-3 border-b border-border py-4" key={identity.id}>
					<span className="min-w-0 wrap-anywhere">
						<strong>{identity.label}</strong>{" "}
						<span className="text-muted-foreground">
							{names[identity.provider]}
							{identity.active ? "" : " · linked through a previous sign-in service"}
						</span>
					</span>
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={busy}
						onClick={() =>
							run(
								unlinkIdentity(identity.id),
								"Waiting for your passkey…",
								"Unlinked. Your other sessions were signed out.",
							)
						}
					>
						Unlink {identity.label}
					</Button>
				</article>
			))}
			{pending && (
				<Card className="mt-4">
					<CardContent>
						<p>
							Link the {names[pending.provider]} account <strong>{pending.label}</strong> to this board?
						</p>
						<Button
							className="mt-3"
							variant="outline"
							size="sm"
							type="button"
							disabled={busy}
							onClick={() =>
								run(
									confirmLink(pending.id).pipe(Effect.tap(() => Effect.sync(linked))),
									"Waiting for your passkey…",
									`${names[pending.provider]} account linked.`,
								)
							}
						>
							Confirm with passkey
						</Button>
					</CardContent>
				</Card>
			)}
			{linkable.length > 0 && (
				<div className="mt-4 flex flex-wrap gap-2">
					{linkable.map((provider) => (
						<Button
							key={provider}
							variant="outline"
							size="sm"
							type="button"
							disabled={busy}
							onClick={() => run(startLink(provider), `Opening ${names[provider]}…`, "")}
						>
							Link {names[provider]}
						</Button>
					))}
				</div>
			)}
			<p className="mt-1.5 text-[10px] leading-relaxed text-subtle">
				A linked account signs you in on this board. It is not a way back in: keep a passkey for each address.
			</p>
			<p className="mt-3 text-xs text-muted-foreground" role="status">
				{message}
			</p>
			{(error ?? loadError) && <Alert className="mt-4">{(error ?? loadError)?.message}</Alert>}
		</section>
	);
}
