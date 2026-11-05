import { BookOpen, ChevronDown, FileText, FolderTree, Hash } from "lucide-react";
import { useState, type ReactNode } from "react";
import { topicHref, type BoardTopic } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { cn } from "./cn.ts";
import { Markdown } from "./markdown.tsx";
import { Link } from "./router.tsx";
import { useIntent } from "./use-intent.ts";
import { Badge } from "./ui/badge.tsx";

const pageHref = (path: string, file: string) =>
	`/p/${[...path.split("/").filter(Boolean), file].map(encodeURIComponent).join("/")}`;

/** Pages other than the README, which has its own place. */
const otherPages = (view: BoardTopic) => view.pages.filter((file) => !(file === "index.md" && view.index !== null));

function SubtopicLink({ item }: { readonly item: BoardTopic["subtopics"][number] }) {
	const { prefetchTopic } = useBoardClient();
	const intent = useIntent(() => prefetchTopic(item.path));
	const note = [
		typeof item.meta.status === "string" ? item.meta.status : null,
		typeof item.meta.description === "string" ? item.meta.description : null,
	]
		.filter((part) => part !== null)
		.join(" · ");
	return (
		<Link
			{...intent}
			href={topicHref(item.path)}
			className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[14px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
		>
			<Hash className="mt-[3px] size-3.5 shrink-0 text-slate" />
			<span className="min-w-0 flex-1">
				<span className={cn("block truncate", item.unread > 0 && "font-semibold text-ink")}>{item.name}</span>
				{note && <span className="block truncate text-[12.5px] text-slate">{note}</span>}
			</span>
			{item.unread > 0 && (
				<Badge variant="count" className="mt-0.5">
					{item.unread > 99 ? "99+" : item.unread}
				</Badge>
			)}
		</Link>
	);
}

function PageLink({ path, file }: { readonly path: string; readonly file: string }) {
	return (
		<a
			href={pageHref(path, file)}
			className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
		>
			<FileText className="size-3.5 shrink-0 text-slate" />
			<span className="min-w-0 truncate">{file}</span>
		</a>
	);
}

function RailSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
	return (
		<section className="mb-6" aria-label={title}>
			<h2 className="mb-1.5 px-2 text-[12.5px] font-medium text-slate">{title}</h2>
			{children}
		</section>
	);
}

/** The README, clamped until asked for in full. */
function Readme({ path, body, clamp }: { readonly path: string; readonly body: string; readonly clamp: string }) {
	const [full, setFull] = useState(false);
	return (
		<div className="rounded-2xl bg-card shadow-raised">
			<div className={cn("relative overflow-hidden px-4 pt-4", !full && clamp)}>
				<div className="text-[14px] [&_.text-\[15px\]]:text-[14px]">
					<Markdown body={body} base={`/p/${path ? path + "/" : ""}index.md`} />
				</div>
				{!full && (
					<div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-card/0" />
				)}
			</div>
			<div className="flex items-center justify-between gap-2 px-4 pt-1 pb-3 text-[13px]">
				<button
					type="button"
					className="cursor-pointer font-medium text-ink-soft hover:text-ink"
					onClick={() => setFull((value) => !value)}
				>
					{full ? "Show less" : "Show more"}
				</button>
				<a className="text-slate no-underline hover:text-ink" href={pageHref(path, "index.md")}>
					Open ↗
				</a>
			</div>
		</div>
	);
}

/** Wide screens: the topic's standing context beside the stream, so the conversation starts at the top. */
export function TopicRail({ path, view }: { readonly path: string; readonly view: BoardTopic }) {
	const pages = otherPages(view);
	if (view.index === null && pages.length === 0 && view.subtopics.length === 0) return null;
	return (
		<aside
			aria-label="About this topic"
			className="sticky top-6 hidden max-h-[calc(100svh-3rem)] overflow-y-auto overscroll-contain pb-6 [scrollbar-width:thin] xl:block"
		>
			{view.index !== null && (
				<RailSection title="README">
					<Readme path={path} body={view.index} clamp="max-h-[42vh]" />
				</RailSection>
			)}
			{view.subtopics.length > 0 && (
				<RailSection title={`Subtopics · ${view.subtopics.length}`}>
					{view.subtopics.map((item) => (
						<SubtopicLink key={item.path} item={item} />
					))}
				</RailSection>
			)}
			{pages.length > 0 && (
				<RailSection title={`Pages · ${pages.length}`}>
					{pages.map((file) => (
						<PageLink key={file} path={path} file={file} />
					))}
				</RailSection>
			)}
		</aside>
	);
}

type Panel = "readme" | "subtopics" | "pages" | null;

/** Narrower screens: one row of chips under the title; each opens its part of the context in place. */
export function TopicContextBar({ path, view }: { readonly path: string; readonly view: BoardTopic }) {
	const pages = otherPages(view);
	const [open, setOpen] = useState<Panel>(() => (view.messages.length === 0 && view.index !== null ? "readme" : null));
	const chips: ReadonlyArray<{ readonly key: Exclude<Panel, null>; readonly label: string; readonly icon: ReactNode }> =
		[
			...(view.index !== null ? [{ key: "readme" as const, label: "README", icon: <BookOpen /> }] : []),
			...(view.subtopics.length > 0
				? [
						{
							key: "subtopics" as const,
							label: `${view.subtopics.length} ${view.subtopics.length === 1 ? "subtopic" : "subtopics"}`,
							icon: <FolderTree />,
						},
					]
				: []),
			...(pages.length > 0
				? [
						{
							key: "pages" as const,
							label: `${pages.length} ${pages.length === 1 ? "page" : "pages"}`,
							icon: <FileText />,
						},
					]
				: []),
		];
	if (chips.length === 0) return null;
	return (
		<div className="mb-5 xl:hidden">
			<div className="flex flex-wrap gap-1.5">
				{chips.map((chip) => (
					<button
						key={chip.key}
						type="button"
						aria-expanded={open === chip.key}
						onClick={() => setOpen((current) => (current === chip.key ? null : chip.key))}
						className={cn(
							"inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13.5px] transition-colors [&_svg]:size-3.5",
							open === chip.key
								? "bg-ink text-white [&_svg]:text-white"
								: "bg-card text-ink-soft shadow-raised hover:text-ink [&_svg]:text-slate",
						)}
					>
						{chip.icon}
						{chip.label}
						<ChevronDown className={cn("transition-transform", open === chip.key && "rotate-180")} />
					</button>
				))}
			</div>
			{open === "readme" && view.index !== null && (
				<div className="mt-3">
					<Readme path={path} body={view.index} clamp="max-h-[50vh]" />
				</div>
			)}
			{open === "subtopics" && (
				<div className="mt-3 rounded-2xl bg-card p-2 shadow-raised">
					{view.subtopics.map((item) => (
						<SubtopicLink key={item.path} item={item} />
					))}
				</div>
			)}
			{open === "pages" && (
				<div className="mt-3 rounded-2xl bg-card p-2 shadow-raised">
					{pages.map((file) => (
						<PageLink key={file} path={path} file={file} />
					))}
				</div>
			)}
		</div>
	);
}
