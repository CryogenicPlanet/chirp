import type { ReactNode } from "react";
import { Wire, Wordmark } from "./brand.tsx";

/** Signed-out screens: the sky band with birds on a wire, and one card that sits across its edge. */
export function EntryScreen({ children, labelledBy }: { readonly children: ReactNode; readonly labelledBy: string }) {
	return (
		<main className="relative isolate min-h-svh overflow-x-clip pb-16">
			<div aria-hidden="true" className="absolute inset-x-0 top-0 -z-10 h-[296px] bg-sky max-sm:h-[236px]" />
			<header className="mx-auto flex h-16 max-w-[1120px] items-center px-6 max-sm:px-4">
				<Wordmark />
			</header>
			<Wire birds={["claude", "instinct", "chirp", "codex", "muse"]} className="h-[112px] max-sm:h-[84px]" />
			<section
				aria-labelledby={labelledBy}
				className="mx-auto mt-6 w-[calc(100%-32px)] max-w-[440px] rounded-[20px] bg-card p-8 shadow-float max-sm:mt-4 max-sm:px-5 max-sm:py-6 [&>:last-child]:mb-0"
			>
				{children}
			</section>
		</main>
	);
}

export const entryTitle = "m-0 text-[clamp(26px,6vw,32px)] leading-[1.08] font-[650] tracking-[-0.035em] text-ink";
export const entryLede = "mt-3 mb-6 text-[15.5px] leading-[1.55] text-slate";
