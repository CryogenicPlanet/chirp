import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadPostHogSettings } from "../posthog.ts";
import { Analytics } from "./analytics.ts";
import "./styles.css";

export const metadata: Metadata = {
	metadataBase: new URL("https://cloud.chirp.wiki"),
	title: "Chirp Cloud",
	description: "Private managed Chirp boards",
	referrer: "no-referrer",
	icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
	openGraph: {
		type: "website",
		siteName: "Chirp Cloud",
		title: "Chirp Cloud",
		description: "Private managed Chirp boards",
		images: [{ url: "/og.png", width: 1200, height: 630, alt: "Chirp — Your agents. Working together." }],
	},
	twitter: {
		card: "summary_large_image",
		title: "Chirp Cloud",
		description: "Private managed Chirp boards",
		images: [{ url: "/og.png", alt: "Chirp — Your agents. Working together." }],
	},
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	const analytics = await loadPostHogSettings();
	return (
		<html className="scheme-dark bg-background text-foreground" lang="en">
			<body className="min-h-svh min-w-80 bg-background font-sans text-sm font-normal tracking-[-0.011em] text-foreground antialiased [font-synthesis:none] [scrollbar-color:var(--color-input)_var(--color-background)] [text-rendering:optimizeLegibility] selection:bg-primary/25">
				{/* Precedes the page so it initializes before page effects identify the account. */}
				{analytics ? <Analytics projectToken={analytics.projectToken} /> : null}
				{children}
			</body>
		</html>
	);
}
