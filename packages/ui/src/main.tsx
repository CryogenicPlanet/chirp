import { RegistryProvider } from "@effect/atom-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { mountPagePalette } from "./page-palette.tsx";
import "./styles.css";

const root = document.getElementById("root");
// Board pages (/p/...) load this same bundle for ⌘K only, whatever elements an authored page has.
if (window.location.pathname.startsWith("/p/") || root === null) mountPagePalette();
else
	createRoot(root).render(
		<StrictMode>
			<RegistryProvider>
				<App />
			</RegistryProvider>
		</StrictMode>,
	);
