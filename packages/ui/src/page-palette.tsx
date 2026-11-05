import { RegistryProvider } from "@effect/atom-react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { BoardClientProvider } from "./board-client.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { DirectoryProvider } from "./directory.tsx";

/**
 * ⌘K on board pages (/p/...). Pages are server-rendered, so the palette mounts into a shadow root: the board's
 * stylesheet styles it without touching the page, and the page's CSS cannot reach in. Results load in full.
 */
export const mountPagePalette = () => {
	if (document.getElementById("chirp-palette") !== null) return;
	const host = document.createElement("div");
	host.id = "chirp-palette";
	document.body.append(host);
	const shadow = host.attachShadow({ mode: "open" });
	const sheet = document.createElement("link");
	sheet.rel = "stylesheet";
	sheet.href = "/assets/style.css";
	const root = document.createElement("div");
	root.style.fontFamily = '"Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif';
	root.style.color = "var(--color-ink)";
	shadow.append(sheet, root);
	// Tailwind's transforms, shadows and rings read custom properties registered with @property, and browsers only
	// honour @property in the document, never inside a shadow root. Register the same ones on the page; they only
	// define --tw-* variables, which the page's own styles do not use.
	void fetch(sheet.href)
		.then((response) => response.text())
		.then((css) => {
			const rules = css.match(/@property\s+--tw-[\w-]+\s*\{[^}]*\}/g);
			if (rules === null) return;
			const style = document.createElement("style");
			style.textContent = rules.join("\n");
			document.head.append(style);
		})
		.catch(() => {});
	createRoot(root).render(
		<RegistryProvider>
			<BoardClientProvider live={false}>
				<DirectoryProvider>
					<CommandPalette go={(href) => window.location.assign(href)} container={root} />
				</DirectoryProvider>
			</BoardClientProvider>
			<Toaster position="bottom-center" />
		</RegistryProvider>,
	);
};
