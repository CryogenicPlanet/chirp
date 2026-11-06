import { Marked } from "marked";
import { createElement, useMemo, type ReactNode } from "react";
import { useDirectory } from "./directory.tsx";
import { mentionOf, mentionPattern, reachable, type Directory } from "./mentions.ts";
import { profileHref } from "./profile-api.ts";
import { Link, spaHref } from "./router.tsx";

const noTerms: ReadonlyArray<string> = [];

export const messageHref = (seq: number) => `/?message=${seq}#message-${seq}`;
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const safeHref = (href: string, base: string) => {
	try {
		const url = new URL(href, new URL(base, window.location.origin));
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
};
const linkClass =
	"rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-[3px] transition-[text-decoration-color] hover:decoration-ink";
// Message references (#12) and mentions (grammar in mentions.ts).
const reference = new RegExp(`((?<![\\w/#])#[1-9][0-9]*(?!\\w)|${mentionPattern.source})`, "u");
const mentionClass = "rounded-[4px] bg-marker/70 px-0.5 font-medium text-ink no-underline hover:bg-marker";

/** Wraps case-insensitive matches of search terms in a highlight. */
const highlighted = (text: string, terms: ReadonlyArray<string>, key: string): ReactNode => {
	if (terms.length === 0) return text;
	const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
	return text.split(pattern).map((part, index) =>
		index % 2 === 1 ? (
			<mark key={`${key}-${index}`} className="rounded-[3px] bg-marker/80 text-ink">
				{part}
			</mark>
		) : (
			part
		),
	);
};

const referenceText = (text: string, directory: Directory | null, terms: ReadonlyArray<string>): ReactNode =>
	text.split(reference).map((part, index) => {
		// split puts each match at an odd index.
		if (index % 2 === 0) return highlighted(part, terms, String(index));
		if (part.startsWith("@")) {
			const target = mentionOf(part);
			// Only names someone answers to are pings; anything else (like @all) stays plain text.
			if (target === null || directory === null || !reachable(directory, target)) return part;
			const name = target.slice(1).split("/")[0] ?? "";
			const group = target === "@here" || directory.custom.some((item) => item.mention === target);
			return (
				<span key={index}>
					{group ? (
						<span className={mentionClass}>{target}</span>
					) : (
						<Link className={mentionClass} href={profileHref(name)}>
							{target}
						</Link>
					)}
					{part.slice(target.length)}
				</span>
			);
		}
		const seq = Number(part.slice(1));
		return Number.isSafeInteger(seq) ? (
			<Link className={linkClass} key={index} href={messageHref(seq)}>
				{part}
			</Link>
		) : (
			part
		);
	});

// Static classes for the renderer's allowlisted elements; no typography plugin is needed.
const markdownClasses: Readonly<Record<string, string>> = {
	p: "my-2.5",
	strong: "font-semibold",
	h1: "mt-5 mb-2 text-[18px] leading-snug font-semibold tracking-[-0.015em]",
	h2: "mt-5 mb-2 text-[16.5px] leading-snug font-semibold tracking-[-0.01em]",
	h3: "mt-4 mb-2 text-[15px] font-semibold",
	h4: "mt-4 mb-2 text-[15px] font-semibold",
	h5: "mt-4 mb-2 text-[15px] font-semibold",
	h6: "mt-4 mb-2 text-[15px] font-semibold",
	ul: "my-2.5 list-disc pl-6 marker:text-slate [&>li:has(>input:first-child)]:-ml-5 [&>li:has(>input:first-child)]:list-none",
	ol: "my-2.5 list-decimal pl-6 marker:text-slate",
	blockquote: "my-2.5 border-l-[3px] border-edge pl-3.5 text-slate",
	code: "rounded bg-wash px-1 py-px font-mono text-[0.86em] ring-1 ring-rule",
	pre: "my-3 overflow-x-auto rounded-xl bg-wash px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre ring-1 ring-rule [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:ring-0",
	table: "my-3 block max-w-full border-collapse overflow-x-auto text-[14px]",
	th: "border border-rule bg-wash px-2.5 py-1.5 text-left font-semibold",
	td: "border border-rule px-2.5 py-1.5 text-left",
	hr: "my-5 border-0 border-t border-rule",
};

/** Untrusted Markdown becomes React nodes; raw HTML stays text and images require a click. */
export function Markdown({
	body,
	base = "/",
	highlight = noTerms,
}: {
	readonly body: string;
	readonly base?: string;
	readonly highlight?: ReadonlyArray<string>;
}) {
	const directory = useDirectory();
	const content = useMemo(() => {
		const parser = new Marked({
			gfm: true,
			breaks: true,
			renderer: {
				html: ({ text }) => escape(text),
				image: ({ href, text }) => `<a href="${escape(safeHref(href, base) ?? "")}">${escape(text || "Image")} ↗</a>`,
			},
		});
		const document = new DOMParser().parseFromString(parser.parse(body, { async: false }), "text/html");
		const render = (node: Node, key: number, references = true): ReactNode => {
			if (node.nodeType === Node.TEXT_NODE)
				return references
					? referenceText(node.textContent ?? "", directory, highlight)
					: highlighted(node.textContent ?? "", highlight, String(key));
			if (!(node instanceof HTMLElement)) return null;
			const tag = node.tagName.toLowerCase();
			const children = Array.from(node.childNodes)
				.filter(
					(child) =>
						!(
							["table", "thead", "tbody", "tr"].includes(tag) &&
							child.nodeType === Node.TEXT_NODE &&
							!child.textContent?.trim()
						),
				)
				.map((child, index) => render(child, index, references && !["code", "pre", "a"].includes(tag)));
			if (tag === "a") {
				const href = safeHref(node.getAttribute("href") ?? "", base);
				if (href !== undefined && spaHref(href) !== null)
					return (
						<Link className={linkClass} key={key} href={href}>
							{children}
						</Link>
					);
				return (
					<a className={linkClass} key={key} href={href} rel="noreferrer">
						{children}
					</a>
				);
			}
			if (tag === "input")
				return (
					<input
						className="mr-1.5 accent-ink"
						key={key}
						type="checkbox"
						checked={node.hasAttribute("checked")}
						disabled
						aria-label="Task status"
					/>
				);
			if (
				![
					"p",
					"strong",
					"em",
					"del",
					"code",
					"pre",
					"blockquote",
					"ul",
					"ol",
					"li",
					"h1",
					"h2",
					"h3",
					"h4",
					"h5",
					"h6",
					"hr",
					"br",
					"table",
					"thead",
					"tbody",
					"tr",
					"th",
					"td",
				].includes(tag)
			)
				return children;
			return createElement(
				tag,
				{
					key,
					className: markdownClasses[tag],
					...(tag === "ol" ? { start: Number(node.getAttribute("start") ?? 1) } : {}),
				},
				...children,
			);
		};
		return Array.from(document.body.childNodes, (node, index) => render(node, index));
	}, [body, base, directory, highlight]);
	return (
		<div className="text-[15px] leading-[1.6] wrap-break-word text-ink [&>:first-child]:mt-0 [&>:last-child]:mb-0">
			{content}
		</div>
	);
}
