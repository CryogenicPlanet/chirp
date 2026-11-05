import { validTopic } from "./ext/core/messages.ts";
import { brandFont, escapeHtml, pageCrumbs, pageHref } from "./page-markdown.ts";

/**
 * Page comments are board messages, so the server only adds the client (page-comments.js) to pages a signed-in
 * human reads at /p. Threads live in the topic that owns the page: the nearest folder that is a topic path, or
 * `pages` for a root-level page or one under folders no topic path can name.
 */
export const commentTopic = (name: string) => {
	const folders = name.split("/").slice(0, -1);
	return folders.map((_, index) => folders.slice(0, folders.length - index).join("/")).find(validTopic) ?? "pages";
};

/** Markdown opts out in frontmatter (`chirp-comments: off`), so quoting the HTML opt-out in a doc never trips it. */
const markdownOptedOut = (text: string) =>
	/^chirp-comments:[ \t]*off[ \t]*$/im.test(text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "");

// The comment client wires this button (CSP allows no inline handlers); the board bundle's palette opens on the event.
const searchStyle = `<style>.chirp-search{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;margin-right:14px;padding:0 9px;height:26px;border-radius:8px;box-shadow:inset 0 0 0 1px #e6e2da;background:#fff;color:#5c6577;font:13px/1 "Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif;cursor:pointer}.chirp-search:hover{color:#202a3a;background:#f1eee7}.chirp-search:focus-visible{outline:2px solid #202a3a;outline-offset:2px}.chirp-search kbd{font:inherit;font-size:12px;color:#5c6577}</style>`;
const searchButton = `<button type="button" class="chirp-search" data-chirp-palette>Search <kbd>⌘K</kbd></button>`;

/**
 * What a signed-in human's page gains: the search button for its bar, plus the comment client and the board bundle,
 * which on a page mounts only the ⌘K palette. Every value is escaped: page names may hold any character.
 */
const chrome = (name: string, viewer: string) => ({
	search: searchButton,
	scripts: `${searchStyle}<script defer src="/page-assets/comments.js" data-page="${escapeHtml(name)}" data-topic="${escapeHtml(commentTopic(name))}" data-viewer="${escapeHtml(viewer)}"></script><script type="module" src="/assets/board.js"></script>`,
});

/** The chrome for a Markdown page, or nothing when its frontmatter opted out. */
export const markdownChrome = (text: string, name: string, viewer: string) =>
	markdownOptedOut(text) ? { search: "", scripts: "" } : chrome(name, viewer);

// Scoped to one class, with `all` reset first, so the bar neither inherits from nor restyles the page.
const barStyle = `<style>${brandFont}.chirp-page-bar{all:initial;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 16px;width:100%;margin:0;padding:9px 20px;background:#f7f5f0;border-bottom:1px solid #e6e2da;color:#5c6577;font:14px/1.5 "Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif}.chirp-page-bar a{all:unset;color:#5c6577;cursor:pointer;border-radius:2px}.chirp-page-bar a:hover{color:#202a3a;text-decoration:underline;text-underline-offset:3px}.chirp-page-bar a:focus-visible{outline:2px solid #202a3a;outline-offset:2px}</style>`;

/**
 * A verbatim HTML page gains the bar at the top of its body and the scripts at the end, parsed rather than matched,
 * so a `<body>` inside a title, comment, style or script is never mistaken for the element. A page with
 * `<meta name="chirp-comments" content="off">` keeps its exact bytes.
 */
export const decorateHtmlPage = (html: string, name: string, viewer: string) => {
	let off = false;
	let body = false;
	new HTMLRewriter()
		.on("meta[name]", {
			element: (meta) => {
				if (
					meta.getAttribute("name")?.toLowerCase() === "chirp-comments" &&
					/^off$/i.test(meta.getAttribute("content") ?? "")
				)
					off = true;
			},
		})
		.on("body", { element: () => void (body = true) })
		.transform(html);
	if (off) return html;
	const { search, scripts } = chrome(name, viewer);
	const bar = `<nav class="chirp-page-bar"><span>${pageCrumbs(name)}</span><span>${search}<a href="${escapeHtml(pageHref(name))}?raw=1">raw</a></span></nav>${barStyle}`;
	if (!body) {
		// No body element: after </head>, else after the doctype, never before it (that would trigger quirks mode).
		const at = /<\/head\s*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
		const index = at ? at.index + at[0].length : 0;
		return html.slice(0, index) + bar + scripts + html.slice(index);
	}
	let closed = false;
	const decorated = new HTMLRewriter()
		.on("body", {
			element: (element) => {
				element.prepend(bar, { html: true });
				element.onEndTag((end) => {
					end.before(scripts, { html: true });
					closed = true;
				});
			},
		})
		.transform(html);
	return closed ? decorated : decorated + scripts;
};
