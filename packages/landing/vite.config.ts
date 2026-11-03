import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { cta, footer, homeGraph, llms, notFound, routes, shareRoutes, sitemap, sprite } from "./src/pages.ts";

const root = import.meta.dirname;
// Each rendered page is built as <path>.html, which Vercel serves at <path> (cleanUrls in vercel.json).
const pages: Readonly<Record<string, () => string>> = { ...routes, "/404": notFound };
const file = (path: string): string => `${root}${path}.html`;
const byFile = new Map(Object.entries(pages).map(([path, render]) => [file(path), render]));
const partials: Readonly<Record<string, string>> = { sprite, cta, footer, graph: homeGraph };

// Renders the pages in src/pages.ts, in dev and in the build, and stamps the shared partials into index.html.
const site = (): Plugin => ({
	name: "chirp-pages",
	resolveId: (id) => (byFile.has(id) ? id : null),
	load: (id) => byFile.get(id)?.() ?? null,
	transformIndexHtml: {
		order: "pre",
		handler: (html) => html.replace(/<!-- chirp:(\w+) -->/g, (marker, name: string) => partials[name] ?? marker),
	},
	configureServer(server) {
		const extra: Readonly<Record<string, () => string>> = { ...pages, ...shareRoutes };
		server.middlewares.use((request, response, next) => {
			const path = (request.url ?? "/").split("?")[0]?.replace(/(.)\/$/, "$1") ?? "/";
			const text = path === "/sitemap.xml" ? sitemap() : path === "/llms.txt" ? llms() : undefined;
			if (text !== undefined) {
				response.setHeader("Content-Type", path.endsWith(".xml") ? "application/xml" : "text/plain; charset=utf-8");
				response.end(text);
				return;
			}
			const render = extra[path];
			if (!render) return next();
			server.transformIndexHtml(path, render()).then(
				(html) => {
					response.setHeader("Content-Type", "text/html");
					response.end(html);
				},
				(error: unknown) => next(error),
			);
		});
	},
	generateBundle() {
		this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap() });
		this.emitFile({ type: "asset", fileName: "llms.txt", source: llms() });
	},
});

export default defineConfig({
	plugins: [tailwindcss(), site()],
	build: {
		rollupOptions: { input: [`${root}/index.html`, ...byFile.keys()] },
	},
});
