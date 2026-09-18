import { Cause, Effect, type FileSystem, Option, Scope, Stream } from "effect";
import { type HttpServerRequest, HttpServerResponse, Mime } from "effect/unstable/http";
import { PageRejected, type Pages, validPagePath } from "./ext/core/pages.ts";
import type { ExtensionCapabilities } from "./kernel/extension-capabilities.ts";
import { escapeHtml, pageDocument, pageHref } from "./page-markdown.ts";
import { htmlHeaders as pageHeaders } from "./html-headers.ts";
import { pageFailure } from "./page-failure.ts";

export interface PageMount {
	readonly root: string;
	readonly mount: `/${string}`;
}

/** UTF-8 without NUL bytes is text; serve it inline instead of forcing a download. */
const looksLikeText = (bytes: Uint8Array) => {
	if (bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
		return true;
	} catch {
		return false;
	}
};

const viewable = (type: string) =>
	type.startsWith("text/") ||
	type.startsWith("image/") ||
	type === "application/pdf" ||
	type === "application/json" ||
	type.endsWith("+json");

const pageContentType = (name: string, mime: string | null, sample: Option.Option<Uint8Array>) => {
	if (name.toLowerCase().endsWith(".md")) return "text/markdown; charset=utf-8";
	if (mime !== null && viewable(mime))
		return mime.startsWith("text/") && !mime.includes("charset") ? `${mime}; charset=utf-8` : mime;
	if (Option.match(sample, { onNone: () => true, onSome: looksLikeText })) return "text/plain; charset=utf-8";
	return mime ?? "application/octet-stream";
};

/** Serve a page subtree through an explicitly chosen URL mount, preserving publication fencing. */
export const servePage = (
	request: HttpServerRequest.HttpServerRequest,
	options: PageMount,
	pages: Pages["Service"],
	read: ExtensionCapabilities["read"],
	fs: FileSystem.FileSystem,
) =>
	Effect.gen(function* () {
		const requestScope = yield* Effect.scope;
		if (request.method !== "GET" && request.method !== "HEAD")
			return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
		// Validate before joining: a malformed root must never become a different page subtree.
		if (!validPagePath(options.root)) return yield* new PageRejected({ code: "page_path_invalid" });
		if (!options.mount.startsWith("/") || options.mount.endsWith("/") || /[?#%\\]/.test(options.mount))
			return yield* new PageRejected({ code: "page_path_invalid" });
		const url = new URL(request.url, "http://localhost");
		if (url.pathname !== options.mount && !url.pathname.startsWith(`${options.mount}/`))
			return yield* new PageRejected({ code: "page_path_invalid" });
		const relative = yield* Effect.try({
			try: () => decodeURIComponent(url.pathname.slice(options.mount.length).replace(/^\//, "").replace(/\/$/, "")),
			catch: () => new PageRejected({ code: "page_path_invalid" }),
		});
		const name = [options.root, relative].filter(Boolean).join("/");
		const display = (selected: string) =>
			options.root ? selected.slice(options.root.length).replace(/^\//, "") : selected;
		return yield* read(() =>
			Effect.gen(function* () {
				let selected = name;
				let target = yield* pages.resolve(name);
				if (target.type === "Directory") {
					if (!url.pathname.endsWith("/")) return HttpServerResponse.redirect(`${url.pathname}/${url.search}`);
					const entries = yield* pages.entries(name);
					const index = ["index.md", "index.html"].find((entry) =>
						entries.some((file) => file.name === entry && !file.directory),
					);
					if (!index)
						return HttpServerResponse.text(
							pageDocument(
								display(name),
								`<h1>${escapeHtml(display(name) || "Pages")}</h1><ul class="listing">${entries.map((entry) => `<li><a href="${escapeHtml(pageHref(display(name ? `${name}/${entry.name}` : entry.name), options.mount))}${entry.directory ? "/" : ""}">${escapeHtml(entry.name)}${entry.directory ? "/" : ""}</a></li>`).join("")}</ul>`,
								{ mount: options.mount },
							),
							{ contentType: "text/html; charset=utf-8", headers: pageHeaders },
						);
					selected = name ? `${name}/${index}` : index;
					target = yield* pages.resolve(selected);
				}
				if (selected.toLowerCase().endsWith(".md") && url.searchParams.get("raw") !== "1")
					return HttpServerResponse.text(
						pages.render(yield* pages.read(selected), display(selected), { mount: options.mount }),
						{
							contentType: "text/html; charset=utf-8",
							headers: pageHeaders,
						},
					);
				// Open while the path and publication visibility are protected. The request scope owns this descriptor, not the SQL snapshot.
				const file = yield* fs.open(target.absolute).pipe(Effect.provideService(Scope.Scope, requestScope));
				const info = yield* file.stat;
				const sample = yield* file.readAlloc(8192);
				const contentType = pageContentType(selected, Option.getOrNull(Mime.getType(selected)), sample);
				if (request.method === "HEAD")
					return HttpServerResponse.empty({
						status: 200,
						headers: { ...pageHeaders, "content-type": contentType, "content-length": String(info.size) },
					});
				return HttpServerResponse.stream(
					Stream.concat(
						Option.match(sample, { onNone: () => Stream.empty, onSome: (bytes) => Stream.make(bytes) }),
						Stream.fromPull(
							Effect.succeed(
								file
									.readAlloc(65536)
									.pipe(
										Effect.flatMap(
											Option.match({ onNone: () => Cause.done(), onSome: (bytes) => Effect.succeed([bytes]) }),
										),
									),
							),
						),
					),
					{ headers: pageHeaders, contentType, contentLength: Number(info.size) },
				);
			}),
		);
	}).pipe(pageFailure);
