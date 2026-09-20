import { AuthButtons } from "./auth-buttons.tsx";

export default function Home() {
	return (
		<main>
			<section className="auth-card">
				<p className="eyebrow">Chirp Cloud</p>
				<h1>Your boards, awake when needed.</h1>
				<p className="lede">
					Private Chirp boards, managed from one secure account. New accounts require an invitation.
				</p>
				<AuthButtons />
			</section>
		</main>
	);
}
