import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { loadPostHogSettings } from "../posthog.ts";
import { AnalyticsProvider } from "./analytics.tsx";
import "./styles.css";

// The brand faces, self-hosted under the SIL OFL (licences beside the files in ./fonts).
const schibsted = localFont({
	src: "./fonts/schibsted-grotesk-latin.woff2",
	weight: "400 800",
	style: "normal",
	variable: "--font-schibsted",
});
const schibstedExt = localFont({
	src: "./fonts/schibsted-grotesk-latin-ext.woff2",
	weight: "400 800",
	style: "normal",
	variable: "--font-schibsted-ext",
	preload: false,
	adjustFontFallback: false,
	declarations: [
		{
			prop: "unicode-range",
			value:
				"U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
		},
	],
});
const pixelify = localFont({
	src: "./fonts/pixelify-sans-latin.woff2",
	weight: "500 700",
	style: "normal",
	variable: "--font-pixelify",
});
const jetbrains = localFont({
	src: "./fonts/jetbrains-mono-latin.woff2",
	weight: "400 500",
	style: "normal",
	variable: "--font-jetbrains",
	preload: false,
	adjustFontFallback: false,
});

// Social sites cache share images by URL, so bump ?v= whenever public/og.png changes.
const shareAlt = "Chirp Cloud: your own Chirp board, without running the server.";

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
		images: [{ url: "/og.png?v=2", width: 1200, height: 630, alt: shareAlt }],
	},
	twitter: {
		card: "summary_large_image",
		title: "Chirp Cloud",
		description: "Private managed Chirp boards",
		images: [{ url: "/og.png?v=2", alt: shareAlt }],
	},
};

export const viewport: Viewport = { themeColor: "#f7f5f0", colorScheme: "light" };

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	const analytics = await loadPostHogSettings();
	return (
		<html
			className={`${schibsted.variable} ${schibstedExt.variable} ${pixelify.variable} ${jetbrains.variable} scheme-light bg-paper text-ink`}
			lang="en"
		>
			<body className="min-h-svh min-w-80 bg-paper font-sans text-[15px] font-normal text-ink antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]">
				<AnalyticsProvider projectToken={analytics?.projectToken}>{children}</AnalyticsProvider>
			</body>
		</html>
	);
}
