import { AuthButtons } from "./auth-buttons.tsx";

export default function Home() {
	return (
		<main className="grid min-h-svh place-items-center p-6 max-[460px]:p-4">
			<section className="w-full max-w-[430px] rounded-md border border-border bg-card p-8 shadow-card max-[460px]:px-5 max-[460px]:py-6">
				<p className="m-0 font-mono text-[11px] font-medium tracking-[0.08em] text-subtle uppercase">Chirp Cloud</p>
				<h1 className="mt-3 mb-0 text-[clamp(28px,7vw,36px)] leading-[1.05] font-normal tracking-[-0.035em] text-balance">
					Your boards, awake when needed.
				</h1>
				<p className="mt-4 mb-6 text-[15px] leading-[1.55] text-muted-foreground">
					Private Chirp boards, managed from one secure account. New accounts require an invitation.
				</p>
				<AuthButtons />
			</section>
		</main>
	);
}
