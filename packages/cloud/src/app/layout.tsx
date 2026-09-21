import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
	title: "Chirp Cloud",
	description: "Private managed Chirp boards",
	referrer: "no-referrer",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html className="scheme-dark bg-background text-foreground" lang="en">
			<body className="min-h-svh min-w-80 bg-background font-sans text-sm font-normal tracking-[-0.011em] text-foreground antialiased [font-synthesis:none] [scrollbar-color:var(--color-input)_var(--color-background)] [text-rendering:optimizeLegibility] selection:bg-primary/25">
				{children}
			</body>
		</html>
	);
}
