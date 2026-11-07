import { Marked } from "marked";
import highlight from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";

export const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
export const pageHref = (name: string, mount = "/p") => `${mount}/${name.split("/").map(encodeURIComponent).join("/")}`;

// The board's brand (packages/ui/src/styles.css) over github-markdown-css, so it follows the asset links.
// The fonts are the board build's fixed /assets files; without them a page keeps the system stack.
const latin =
	"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const latinExt =
	"U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF";
const font = (family: string, file: string, style: string, weight: string, range: string) =>
	`@font-face{font-family:"${family}";src:url(/assets/${file}.woff2) format("woff2");font-style:${style};font-weight:${weight};font-display:swap;unicode-range:${range}}`;
/** The board's sans face, which page comments also declare on verbatim HTML pages. */
export const brandFont =
	font("Schibsted Grotesk", "schibsted-grotesk-latin", "normal", "400 800", latin) +
	font("Schibsted Grotesk", "schibsted-grotesk-latin-ext", "normal", "400 800", latinExt);
const pageStyle = [
	brandFont,
	font("Schibsted Grotesk", "schibsted-grotesk-italic-latin", "italic", "400 800", latin),
	font("JetBrains Mono", "jetbrains-mono-latin", "normal", "400 500", latin),
	':root{color-scheme:light}body{margin:0;background:#f7f5f0;color:#202a3a;font:16px/1.65 "Schibsted Grotesk",ui-sans-serif,system-ui,sans-serif}',
	".wrap{max-width:760px;margin:0 auto;padding:40px 20px 12vh}nav{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;margin-bottom:32px;font-size:14px;color:#5c6577}nav a{color:inherit;text-decoration:none}nav a:hover{color:#202a3a}",
	"a{color:#202a3a;text-decoration:underline;text-decoration-color:rgb(32 42 58/.3);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}:focus-visible{outline:2px solid #202a3a;outline-offset:3px;border-radius:2px}::selection{background:rgb(255 227 122/.6)}pre{overflow:auto}img{max-width:100%}.listing{padding-left:1.2rem}",
	".markdown-body{color:inherit;background:transparent;font:inherit}.markdown-body a,.markdown-body a:hover{color:#202a3a;text-decoration:underline;text-decoration-color:rgb(32 42 58/.3);text-underline-offset:3px}.markdown-body a:hover{text-decoration-color:currentColor}",
	".markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{font-weight:650;line-height:1.2;letter-spacing:-.015em}.markdown-body h1{font-size:2.125em;letter-spacing:-.035em;border:0;padding:0}.markdown-body h2{font-size:1.5em;letter-spacing:-.025em;border-bottom:1px solid #e6e2da}.markdown-body h6{color:#5c6577}",
	".markdown-body hr{height:1px;background:#e6e2da}.markdown-body blockquote{color:#5c6577;border-left:3px solid #918c82}.markdown-body mark{background:#ffe37a;color:inherit;border-radius:3px;padding:0 2px}.markdown-body strong{font-weight:650}",
	'.markdown-body code,.markdown-body kbd,.markdown-body pre,.markdown-body samp,.markdown-body tt{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}.markdown-body code,.markdown-body tt{background:#f1eee7;box-shadow:0 0 0 1px #e6e2da;border-radius:4px}.markdown-body kbd{background:#f1eee7;color:#202a3a}',
	".markdown-body pre{background:#f1eee7;color:#202a3a;border-radius:12px;box-shadow:inset 0 0 0 1px #e6e2da}.markdown-body pre>code,.markdown-body pre tt{box-shadow:none;padding:0}",
	// highlight.js's GitHub theme is tuned for a near-white background; these four token colours fall under 4.5:1 on wash.
	".hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#b4412f}.hljs-built_in,.hljs-symbol{color:#a14a10}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag,.hljs-addition{color:#237a4c}.hljs-code,.hljs-comment,.hljs-formula{color:#5c6577}",
	".markdown-body table th,.markdown-body table td{border-color:#e6e2da}.markdown-body table th:not([align]){text-align:left}.markdown-body table,.markdown-body li::marker{font-variant-numeric:normal}.markdown-body table tr{background:transparent;border-top-color:#e6e2da}.markdown-body table tr:nth-child(2n){background:#f1eee7}.markdown-body .footnotes{color:#5c6577;border-top-color:#e6e2da}",
].join("");
// chirp.wiki's favicon (packages/landing/public/favicon.svg), inline so it needs no signed-in request.
const favicon =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Cpath fill='%23ed9b83' d='M8 20h8V12h16v8h8v8h-8v8H16v-8H8zM8 12h8v8H8zM16 36h8v8h-8z'/%3E%3Cpath fill='%23161b1d' d='M24 16h4v4h-4z'/%3E%3C/svg%3E";
/** Breadcrumb links from the board root to a page, each segment escaped for HTML and encoded for its href. */
export const pageCrumbs = (name: string, mount = "/p") => {
	let current = "";
	const crumbs = [...(mount === "/p" ? ['<a href="/">chirp</a>'] : []), `<a href="${escapeHtml(mount)}/">pages</a>`];
	for (const part of name.split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		crumbs.push(`<a href="${escapeHtml(pageHref(current, mount))}">${escapeHtml(part)}</a>`);
	}
	return crumbs.join(" / ");
};
export const pageDocument = (
	name: string,
	body: string,
	options: {
		title?: string;
		raw?: string;
		rawHref?: string;
		assets?: string;
		mount?: string;
		/** Page chrome for a signed-in reader (page-comments.ts): a nav control and trailing scripts. */
		chrome?: { readonly search: string; readonly scripts: string };
	} = {},
) => {
	const mount = options.mount ?? "/p";
	const raw =
		options.rawHref || options.raw
			? `<a href="${escapeHtml(options.rawHref ?? `${pageHref(options.raw ?? "", mount)}?raw=1`)}">raw</a>`
			: "";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f7f5f0"><link rel="icon" type="image/svg+xml" href="${favicon}"><title>${escapeHtml(options.title ?? (name || "Pages"))}</title>
${options.assets ?? ""}<style>${pageStyle}</style></head><body><div class="wrap"><nav><span>${pageCrumbs(name, mount)}</span>${options.chrome?.search ? `<span>${options.chrome.search}${raw}</span>` : raw}</nav><article class="markdown-body">${body}</article></div>${options.chrome?.scripts ?? ""}</body></html>`;
};

/** Each Pages instance owns its parser and highlighter; never change package defaults. */
export const pageMarkdown = () => {
	const highlighter = highlight.newInstance();
	for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, xml, css, sql, yaml }))
		highlighter.registerLanguage(name, language);
	const parser = new Marked({
		gfm: true,
		breaks: false,
		renderer: {
			// GitHub-style ids, so a page's `#section` links land in the browser as they do on GitHub.
			heading({ tokens, depth, text }) {
				const id = text
					.toLowerCase()
					.replace(/[^\p{L}\p{N}\s_-]/gu, "")
					.trim()
					.replace(/\s/g, "-");
				return `<h${depth}${id ? ` id="${escapeHtml(id)}"` : ""}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
			},
			code({ text, lang }) {
				const language = lang?.split(/\s+/)[0] ?? "";
				if (language === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
				const rendered =
					language && highlighter.getLanguage(language)
						? highlighter.highlight(text, { language }).value
						: escapeHtml(text);
				return `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${rendered}</code></pre>`;
			},
		},
	});
	return (
		text: string,
		name: string,
		options: {
			rawHref?: string;
			mount?: string;
			chrome?: { readonly search: string; readonly scripts: string };
		} = {},
	) => {
		const matched = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		const frontmatter = matched?.[1] ?? "";
		const body = parser.parse(matched ? text.slice(matched[0].length) : text, { async: false });
		const tailwind = /<!--\s*tailwind\s*-->/i.test(text) || /^tailwind:[ \t]*true[ \t]*$/m.test(frontmatter);
		const assets = `<link rel="stylesheet" href="/page-assets/markdown.css">${body.includes('class="hljs') ? '<link rel="stylesheet" href="/page-assets/highlight.css">' : ""}${body.includes('class="mermaid"') ? '<script defer src="/page-assets/mermaid.js"></script><script defer src="/page-assets/mermaid-init.js"></script>' : ""}${tailwind ? '<style type="text/tailwindcss">@layer theme, utilities; @import "tailwindcss/theme" layer(theme); @import "tailwindcss/utilities" layer(utilities);</style><script defer src="/page-assets/tailwind.js"></script>' : ""}`;
		return pageDocument(name, body, { title: text.match(/^#\s+(.+)$/m)?.[1] ?? name, raw: name, ...options, assets });
	};
};
