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
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
