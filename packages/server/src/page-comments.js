// Page comments: select text on a board page to start a thread. Ported from ctx's comment layer.
//
// Threads are ordinary board messages in the topic that owns the page, tagged `page-comment`, so agents read and
// answer them like any other message. A root carries meta.page and meta.anchor (a text quote plus context, so it
// re-finds its place after edits); a reply carries meta.thread, the root's id. Resolving rewrites the root's meta.
// Highlights use the CSS Custom Highlight API, so the page's own DOM is never touched; the UI lives in a shadow root.
// The server adds this script only for signed-in people reading /p (page-comments.ts); docs in pages/docs/recipes.md.
(() => {
	"use strict";
	const script = document.currentScript;
	if (window.top !== window || window.__chirpComments || !(script instanceof HTMLScriptElement)) return;
	window.__chirpComments = true;
	// The bar's search button; the board bundle (/assets/board.js) mounts the ⌘K palette and listens for this event.
	for (const button of document.querySelectorAll("[data-chirp-palette]"))
		button.addEventListener("click", () => window.dispatchEvent(new Event("chirp:open-palette")));
	const PAGE = script.dataset.page || "";
	const TOPIC = script.dataset.topic || "";
	const VIEWER = script.dataset.viewer || "";
	if (!PAGE || !TOPIC) return;

	const TAG = "page-comment";
	const CONTEXT = 40;
	const MAX_QUOTE = 2000;
	const POLL_MS = 20000;
	const HAS_HL = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
	const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
	// The server's mention grammar (ext/core/message-mentions.ts), used only to highlight mentions in the panel.
	const MENTION = /(?<![\p{L}\p{N}\p{M}@/:])@[a-z0-9][a-z0-9._/-]*(?![\p{L}\p{N}\p{M}@/._-])/gu;

	let threads = [];
	let spans = new Map();
	let activeId = null;
	let panelOpen = false;
	let showResolved = false;
	let draft = null;
	const drafts = new Map();
	let selection = null;
	let lastPayload = "";
	let errorMsg = "";
	let busy = false;

	// ── text index: every visible-ish text node of the page content, in document order ──────────────────────────
	const contentRoot = () => document.querySelector("article.markdown-body") || document.body;
	let indexCache = null;
	function index() {
		if (indexCache) return indexCache;
		const root = contentRoot();
		const nodes = [];
		const starts = [];
		const pos = new Map();
		let text = "";
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode(n) {
				if (!n.data.length) return NodeFilter.FILTER_REJECT;
				for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
					if (SKIP_TAGS.has(p.tagName) || p.classList.contains("chirp-page-bar")) return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			pos.set(n, nodes.length);
			nodes.push(n);
			starts.push(text.length);
			text += n.data;
		}
		indexCache = { nodes, starts, pos, text };
		return indexCache;
	}

	function boundaryToOffset(idx, container, offset) {
		if (container.nodeType === Node.TEXT_NODE) {
			const i = idx.pos.get(container);
			if (i !== undefined) return idx.starts[i] + Math.min(offset, container.data.length);
		}
		const r = document.createRange();
		r.setStart(container, offset);
		let lo = 0;
		let hi = idx.nodes.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (r.comparePoint(idx.nodes[mid], 0) < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo < idx.nodes.length ? idx.starts[lo] : idx.text.length;
	}

	function locate(idx, off, isEnd) {
		let lo = 0;
		let hi = idx.nodes.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (isEnd ? idx.starts[mid] < off : idx.starts[mid] <= off) lo = mid;
			else hi = mid - 1;
		}
		const node = idx.nodes[lo];
		return { node, off: Math.max(0, Math.min(off - idx.starts[lo], node.data.length)) };
	}

	function rangeFor(idx, s, e) {
		const a = locate(idx, s, false);
		const b = locate(idx, e, true);
		const r = document.createRange();
		r.setStart(a.node, a.off);
		r.setEnd(b.node, b.off);
		return r;
	}

	// ── anchoring: find the quote again, preferring the copy whose context and position match best ─────────────
	function commonSuffix(a, b) {
		let n = 0;
		while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
		return n;
	}
	function commonPrefix(a, b) {
		let n = 0;
		while (n < a.length && n < b.length && a[n] === b[n]) n++;
		return n;
	}

	function candidates(text, quote) {
		const out = [];
		for (let at = text.indexOf(quote); at !== -1 && out.length < 500; at = text.indexOf(quote, at + 1)) {
			out.push({ s: at, e: at + quote.length });
		}
		if (out.length) return out;
		// Whitespace-only edits (re-wrapped Markdown, re-indented HTML) still match.
		const words = quote
			.trim()
			.split(/\s+/)
			.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		if (!words.length || !words[0]) return out;
		const re = new RegExp(words.join("\\s+"), "g");
		for (let m = re.exec(text); m && out.length < 500; m = re.exec(text))
			out.push({ s: m.index, e: m.index + m[0].length });
		return out;
	}

	function anchor(idx, a) {
		if (!a || !a.quote || !idx.nodes.length) return null;
		let best = null;
		let bestScore = -Infinity;
		for (const c of candidates(idx.text, a.quote)) {
			let score = commonSuffix(idx.text.slice(Math.max(0, c.s - CONTEXT), c.s), a.prefix || "");
			score += commonPrefix(idx.text.slice(c.e, c.e + CONTEXT), a.suffix || "");
			score -= Math.abs(c.s - (a.offset || 0)) / 5000;
			if (score > bestScore) {
				bestScore = score;
				best = { s: c.s, e: c.e };
			}
		}
		return best && { ...best, range: rangeFor(idx, best.s, best.e) };
	}

	function reanchor() {
		indexCache = null;
		const idx = index();
		spans = new Map();
		for (const t of threads) {
			const hit = anchor(idx, t.anchor);
			if (hit) spans.set(t.id, hit);
		}
		if (draft) {
			const hit = anchor(idx, draft.anchor);
			if (hit) Object.assign(draft, { s: hit.s, e: hit.e });
		}
		paint();
	}

	// ── highlights ───────────────────────────────────────────────────────────────────────────────────────────────
	function paint() {
		if (!HAS_HL) return;
		const normal = new Highlight();
		const active = new Highlight();
		active.priority = 1;
		for (const t of threads) {
			const sp = spans.get(t.id);
			if (!sp) continue;
			if (t.id === activeId) active.add(sp.range);
			else if (t.status === "open") normal.add(sp.range);
		}
		if (draft) active.add(rangeFor(index(), draft.s, draft.e));
		CSS.highlights.set("chirp-comment", normal);
		CSS.highlights.set("chirp-comment-active", active);
	}

	const pageStyle = document.createElement("style");
	pageStyle.textContent =
		"::highlight(chirp-comment){background-color:rgb(255 227 122/.55)}" +
		"::highlight(chirp-comment-active){background-color:#ffe37a;text-decoration:underline;text-decoration-color:#202a3a}";
	document.head.appendChild(pageStyle);

	// ── board messages ───────────────────────────────────────────────────────────────────────────────────────────
	const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	const key = () =>
		crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);

	/** A board write: POST or PATCH with a JSON body and a fresh idempotency key. */
	async function call(method, path, body) {
		const res = await fetch(path, {
			method,
			credentials: "same-origin",
			headers: { "content-type": "application/json", "idempotency-key": key() },
			// oxlint-disable-next-line unicorn/no-invalid-fetch-options -- callers pass only POST and PATCH.
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			const error = isRecord(data.error) ? data.error : {};
			throw new Error(error.message || error.code || "HTTP " + res.status);
		}
		return data;
	}

	/** Every page-comment message in the topic, oldest first. Edits never change a sequence, so read from zero. */
	async function readAll() {
		const items = [];
		let since = 0;
		for (let page = 0; page < 50; page++) {
			const query = new URLSearchParams({ topic: TOPIC, tag: TAG, since: String(since), limit: "200", mark: "0" });
			const res = await fetch("/api/messages?" + query, { credentials: "same-origin", cache: "no-store" });
			if (!res.ok) throw new Error(res.status === 401 ? "sign in again to see comments" : "HTTP " + res.status);
			const data = await res.json();
			items.push(...data.items);
			if (data.items.length < 200 || data.cursor <= since) break;
			since = data.cursor;
		}
		return items;
	}

	function validAnchor(a) {
		return isRecord(a) && typeof a.quote === "string" && a.quote.trim() !== "";
	}

	function toThreads(items) {
		const live = items.filter((m) => m.deleted_at === null && isRecord(m.meta));
		const roots = live.filter(
			(m) => m.meta.page === PAGE && typeof m.meta.thread !== "string" && validAnchor(m.meta.anchor),
		);
		const ids = new Set(roots.map((m) => m.id));
		const replies = live.filter((m) => typeof m.meta.thread === "string" && ids.has(m.meta.thread));
		return roots.map((root) => ({
			id: root.id,
			root,
			anchor: root.meta.anchor,
			status: root.meta.status === "resolved" ? "resolved" : "open",
			resolvedBy: typeof root.meta.resolved_by === "string" ? root.meta.resolved_by : null,
			comments: [root, ...replies.filter((m) => m.meta.thread === root.id)],
		}));
	}

	async function load() {
		try {
			const items = await readAll();
			const payload = JSON.stringify(items);
			if (payload === lastPayload) return;
			lastPayload = payload;
			threads = toThreads(items);
			errorMsg = "";
			reanchor();
			render();
		} catch (e) {
			errorMsg = "Couldn't load comments: " + e.message;
			render();
		}
	}

	async function mutate(fn) {
		if (busy) return;
		busy = true;
		errorMsg = "";
		try {
			await fn();
			lastPayload = "";
			await load();
		} catch (e) {
			errorMsg = e.message;
		} finally {
			busy = false;
			render();
		}
	}

	// ── message bodies: they must read well on the board without the page ────────────────────────────────────────
	const clip = (s, n) => {
		const t = s.replace(/\s+/g, " ").trim();
		return t.length > n ? t.slice(0, n - 1) + "…" : t;
	};
	// Markdown punctuation is escaped, and a word joiner after each @ keeps a quoted excerpt from pinging anyone.
	const quoteMarkdown = (s) => s.replace(/[\\`*_[\]<>#|~]/g, "\\$&").replace(/@/g, "@\u2060");
	const pageUrl = () =>
		location.origin +
		"/p/" +
		PAGE.split("/")
			.map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16)))
			.join("/");
	const LINK = /^— on \[.*\]\(.*\)$/;
	const rootBody = (quote, comment) =>
		`> ${quoteMarkdown(clip(quote, 280))}\n\n${comment}\n\n— on [${PAGE.replace(/[\\[\]]/g, "\\$&")}](${pageUrl()})`;
	/** The comment itself, without the excerpt and link a root adds for the board. */
	function commentText(m) {
		if (typeof m.meta.thread === "string") return m.body;
		const lines = m.body.split("\n");
		let i = 0;
		while (i < lines.length && lines[i].startsWith(">")) i++;
		while (i < lines.length && !lines[i].trim()) i++;
		let j = lines.length;
		if (j > i && LINK.test(lines[j - 1])) j--;
		while (j > i && !lines[j - 1].trim()) j--;
		return i < j ? lines.slice(i, j).join("\n") : m.body;
	}

	// ── UI shell ─────────────────────────────────────────────────────────────────────────────────────────────────
	const host = document.createElement("chirp-comments");
	host.style.cssText = "all:initial;position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;";
	const root = host.attachShadow({ mode: "open" });
	document.body.appendChild(host);
	// Keep the page's keyboard shortcuts from firing while someone types a comment.
	for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());

	const bubble =
		'<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 2.6A.5.5 0 0 1 3 13.2V11h0A1.5 1.5 0 0 1 2 9.5z"/></svg>';
	root.innerHTML = `<style>
		:host { color-scheme: light; }
		* { box-sizing: border-box; }
		.ui { font: 14px/1.5 "Schibsted Grotesk", ui-sans-serif, system-ui, sans-serif; color: #202a3a; }
		button { font: inherit; cursor: pointer; }
		button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid #202a3a; outline-offset: 2px; }
		.fab { position: fixed; display: none; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border: 0; border-radius: 999px; background: #202a3a; color: #fff; font-size: 13.5px; font-weight: 600; box-shadow: 0 0 0 1px rgb(32 42 58/.08), 0 2px 4px rgb(32 42 58/.05), 0 18px 40px -16px rgb(32 42 58/.45); }
		.fab:hover { background: #3a4558; }
		.launch { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 7px; height: 38px; padding: 0 14px; border: 0; border-radius: 999px; background: #fff; color: #202a3a; font-size: 13.5px; font-weight: 600; box-shadow: 0 0 0 1px rgb(32 42 58/.08), 0 2px 4px rgb(32 42 58/.05), 0 30px 70px -24px rgb(32 42 58/.35); }
		.launch:hover { background: #f1eee7; }
		.launch .n { min-width: 20px; padding: 0 6px; border-radius: 10px; background: #ffe37a; text-align: center; font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums; }
		.panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(380px, 100vw); display: none; flex-direction: column; background: #f7f5f0; border-left: 1px solid #e6e2da; box-shadow: 0 30px 70px -24px rgb(32 42 58/.35); }
		.panel.open { display: flex; }
		.head { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #e6e2da; }
		.head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
		.chip { height: 28px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: #5c6577; font-size: 12.5px; box-shadow: inset 0 0 0 1px #e6e2da; }
		.chip.on { background: #202a3a; color: #fff; box-shadow: none; }
		.x { border: 0; border-radius: 8px; background: none; font-size: 20px; line-height: 1; color: #5c6577; padding: 2px 7px; }
		.x:hover { background: #f1eee7; color: #202a3a; }
		.where { padding: 8px 16px 0; color: #5c6577; font-size: 12.5px; }
		.where a { color: inherit; }
		.list { flex: 1; overflow-y: auto; padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 12px; }
		.empty { margin: 28px 10px; color: #5c6577; text-align: center; }
		.err { margin: 10px 14px 0; padding: 8px 11px; border-radius: 10px; background: #fbeae6; color: #b4412f; font-size: 13px; }
		.card { background: #fff; border-radius: 14px; padding: 12px 14px; box-shadow: 0 0 0 1px rgb(32 42 58/.07), 0 1px 3px rgb(32 42 58/.06), 0 6px 16px -6px rgb(32 42 58/.08); }
		.card.active { box-shadow: 0 0 0 2px #202a3a, 0 6px 16px -6px rgb(32 42 58/.12); }
		.card.resolved { opacity: .72; }
		.quote { margin: 0 0 6px; padding-left: 10px; border-left: 3px solid #ffe37a; color: #5c6577; overflow-wrap: anywhere; cursor: pointer; }
		.tags { display: flex; gap: 6px; margin-bottom: 6px; }
		.tag { padding: 0 7px; border-radius: 6px; background: #f1eee7; color: #5c6577; font-size: 12px; }
		.c { display: grid; grid-template-columns: 26px 1fr; gap: 9px; margin-top: 10px; }
		.av { width: 26px; height: 26px; border-radius: 8px; color: #fff; font-size: 12px; font-weight: 700; display: grid; place-items: center; text-transform: uppercase; }
		.meta { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; font-size: 13px; color: #5c6577; }
		.who { font-weight: 600; color: #202a3a; overflow-wrap: anywhere; }
		.label { font-weight: 400; color: #5c6577; }
		.when { margin-left: auto; font-size: 12px; color: #5c6577; text-decoration: none; }
		.when:hover { color: #202a3a; text-decoration: underline; }
		.body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 1px; }
		.body mark { background: #ffe37a; color: inherit; border-radius: 3px; padding: 0 2px; }
		textarea { width: 100%; min-height: 64px; margin-top: 10px; padding: 8px 10px; border: 0; border-radius: 10px; font: inherit; resize: vertical; background: #fff; color: inherit; box-shadow: inset 0 0 0 1px #918c82; }
		textarea:focus { outline: none; box-shadow: inset 0 0 0 2px #202a3a; }
		.row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 10px; }
		.row .grow { flex: 1; }
		.btn { height: 32px; padding: 0 12px; border: 0; border-radius: 10px; background: #fff; color: #202a3a; font-size: 13px; font-weight: 500; box-shadow: 0 0 0 1px rgb(32 42 58/.12); }
		.btn:hover { background: #f1eee7; }
		.btn.primary { background: #202a3a; color: #fff; box-shadow: none; }
		.btn.primary:hover { background: #3a4558; }
		.btn:disabled { opacity: .5; cursor: default; }
		.hint { color: #5c6577; font-size: 12px; }
		.section { margin: 6px 2px 0; color: #5c6577; font-size: 12px; font-weight: 600; }
		@media print { .ui { display: none; } }
	</style>
	<div class="ui">
		<button class="fab" type="button">${bubble} Comment</button>
		<button class="launch" type="button" title="Page comments">${bubble} <span class="n">0</span></button>
		<aside class="panel" aria-label="Page comments">
			<div class="head"><h2>Comments</h2><button class="chip resolved-toggle" type="button"></button><button class="x" type="button" title="Close (Esc)" aria-label="Close">×</button></div>
			<div class="where"></div>
			<div class="errwrap"></div>
			<div class="list"></div>
		</aside>
	</div>`;

	const $ = (sel) => root.querySelector(sel);
	const fab = $(".fab");
	const launch = $(".launch");
	const panel = $(".panel");
	const list = $(".list");

	// ── rendering ────────────────────────────────────────────────────────────────────────────────────────────────
	function esc(s) {
		return String(s).replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
		);
	}
	const topicHref = (path) => "/t/" + path.split("/").map(encodeURIComponent).join("/");
	const messageHref = (seq) => `/?message=${seq}#message-${seq}`;
	const PALETTE = ["#202a3a", "#b4412f", "#237a4c", "#a14a10", "#5c6577", "#3d5a99", "#7a4c8f", "#2f6f73"];
	function colorOf(agent) {
		let h = 0;
		for (const ch of String(agent)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		return PALETTE[h % PALETTE.length];
	}
	function ago(ms) {
		const s = Math.max(0, (Date.now() - ms) / 1000);
		if (s < 60) return "just now";
		if (s < 3600) return Math.floor(s / 60) + "m ago";
		if (s < 86400) return Math.floor(s / 3600) + "h ago";
		if (s < 86400 * 7) return Math.floor(s / 86400) + "d ago";
		return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
	}
	// Same rule as the board's authorLabel (@comms/protocol messages.ts).
	const labelOf = (m) =>
		typeof m.meta.author_label === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.meta.author_label)
			? m.meta.author_label
			: null;
	const withMentions = (text) =>
		esc(text).replace(MENTION, (m) => {
			const target = m.replace(/[._-]+$/u, "");
			return `<mark>${target}</mark>${m.slice(target.length)}`;
		});

	function commentHtml(m) {
		const label = labelOf(m);
		return `<div class="c"><div class="av" style="background:${colorOf(m.agent)}" aria-hidden="true">${esc(m.agent.replace(/^@/, "").charAt(0))}</div>
			<div><div class="meta"><span class="who">${esc(m.agent)}${label ? `<span class="label">@${esc(label)}</span>` : ""}</span><a class="when" href="${messageHref(m.seq)}" title="${esc(new Date(m.created_at).toLocaleString())} · open on the board">${ago(m.created_at)}${m.edited_at ? " · edited" : ""}</a></div><div class="body">${withMentions(commentText(m))}</div></div></div>`;
	}

	function threadHtml(t) {
		const active = t.id === activeId;
		const tags = [];
		if (!spans.has(t.id))
			tags.push(`<span class="tag" title="The quoted text is no longer on the page">Detached</span>`);
		if (t.status === "resolved")
			tags.push(`<span class="tag">Resolved${t.resolvedBy ? " by " + esc(t.resolvedBy) : ""}</span>`);
		const reply = active
			? `<textarea data-draft="reply:${esc(t.id)}" placeholder="Reply… (⌘↵ to send)">${esc(drafts.get("reply:" + t.id) ?? "")}</textarea>`
			: "";
		return `<div class="card${active ? " active" : ""}${t.status === "resolved" ? " resolved" : ""}" data-tid="${esc(t.id)}">
			${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
			<p class="quote" data-act="focus" data-tid="${esc(t.id)}">“${esc(clip(t.anchor.quote, 160))}”</p>
			${t.comments.map(commentHtml).join("")}
			${reply}
			<div class="row"><span class="grow"></span>
				<button class="btn" type="button" data-act="status" data-tid="${esc(t.id)}"${busy ? " disabled" : ""}>${t.status === "resolved" ? "Reopen" : "Resolve"}</button>
				${active ? `<button class="btn primary" type="button" data-act="reply" data-tid="${esc(t.id)}"${busy ? " disabled" : ""}>Reply</button>` : ""}</div>
		</div>`;
	}

	function draftHtml() {
		return `<div class="card active">
			<p class="quote">“${esc(clip(draft.anchor.quote, 160))}”</p>
			<textarea data-draft="new" placeholder="Add a comment… @mention an agent to ask it (⌘↵ to post)">${esc(drafts.get("new") ?? "")}</textarea>
			<div class="row"><span class="hint grow">as ${esc(VIEWER || "you")}</span><button class="btn" type="button" data-act="cancel-new">Cancel</button><button class="btn primary" type="button" data-act="post"${busy ? " disabled" : ""}>Comment</button></div>
		</div>`;
	}

	function render() {
		const open = threads.filter((t) => t.status === "open");
		const resolved = threads.filter((t) => t.status === "resolved");
		launch.querySelector(".n").textContent = String(open.length);
		$(".resolved-toggle").textContent = "Resolved " + resolved.length;
		$(".resolved-toggle").classList.toggle("on", showResolved);
		$(".where").innerHTML = `Posted to <a href="${esc(topicHref(TOPIC))}">${esc(TOPIC)}</a> on the board`;
		$(".errwrap").innerHTML = errorMsg ? `<p class="err">${esc(errorMsg)}</p>` : "";
		panel.classList.toggle("open", panelOpen);
		launch.style.display = panelOpen ? "none" : "flex";
		if (!panelOpen) return;

		const focused = root.activeElement;
		const focusKey = focused && focused.getAttribute ? focused.getAttribute("data-draft") : null;
		const caret = focusKey && "selectionStart" in focused ? focused.selectionStart : null;

		const position = (t) => spans.get(t.id)?.s ?? Infinity;
		const visible = threads
			.filter((t) => showResolved || t.status === "open" || t.id === activeId)
			.sort((a, b) => position(a) - position(b) || a.root.seq - b.root.seq);
		const attached = visible.filter((t) => spans.has(t.id));
		const detached = visible.filter((t) => !spans.has(t.id));

		let html = draft ? draftHtml() : "";
		html += attached.map(threadHtml).join("");
		if (detached.length)
			html += `<p class="section">Detached: the quoted text was edited away</p>` + detached.map(threadHtml).join("");
		if (!html) html = `<p class="empty">Select any text on the page, then choose <b>Comment</b>.</p>`;
		list.innerHTML = html;

		if (focusKey) {
			const el = Array.from(list.querySelectorAll("[data-draft]")).find(
				(n) => n.getAttribute("data-draft") === focusKey,
			);
			if (el) {
				el.focus();
				if (caret !== null) el.setSelectionRange(caret, caret);
			}
		}
	}

	// ── interactions ─────────────────────────────────────────────────────────────────────────────────────────────
	const cardFor = (id) => Array.from(list.querySelectorAll(".card[data-tid]")).find((n) => n.dataset.tid === id);
	function activate(id, { scroll = true } = {}) {
		activeId = id;
		panelOpen = true;
		paint();
		render();
		cardFor(id)?.scrollIntoView({ block: "nearest" });
		const sp = spans.get(id);
		if (scroll && sp) sp.range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
	}

	function hideFab() {
		fab.style.display = "none";
		selection = null;
	}

	const inUi = (e) => e.composedPath().includes(host);

	function onSelectionEnd(e) {
		if (e && inUi(e)) return;
		const sel = document.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return hideFab();
		const r = sel.getRangeAt(0);
		if (!contentRoot().contains(r.commonAncestorContainer)) return hideFab();
		const idx = index();
		let s = boundaryToOffset(idx, r.startContainer, r.startOffset);
		let e2 = boundaryToOffset(idx, r.endContainer, r.endOffset);
		while (s < e2 && /\s/.test(idx.text[s])) s++;
		while (e2 > s && /\s/.test(idx.text[e2 - 1])) e2--;
		if (e2 - s < 1) return hideFab();
		selection = { s, e: Math.min(e2, s + MAX_QUOTE) };
		const rects = r.getClientRects();
		const last = rects[rects.length - 1] || r.getBoundingClientRect();
		fab.style.display = "flex";
		const w = fab.offsetWidth || 110;
		fab.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, last.right - w / 2)) + "px";
		fab.style.top = Math.min(window.innerHeight - 44, last.bottom + 8) + "px";
	}

	document.addEventListener("mouseup", (e) => setTimeout(() => onSelectionEnd(e), 0));
	document.addEventListener("keyup", (e) => {
		if (e.shiftKey || e.key === "Shift") onSelectionEnd(e);
	});
	document.addEventListener("selectionchange", () => {
		const sel = document.getSelection();
		if (!sel || sel.isCollapsed) hideFab();
	});
	window.addEventListener("scroll", hideFab, { passive: true });

	fab.addEventListener("mousedown", (e) => e.preventDefault());
	fab.addEventListener("click", () => {
		if (!selection) return;
		const idx = index();
		const { s, e } = selection;
		draft = {
			s,
			e,
			anchor: {
				quote: idx.text.slice(s, e),
				prefix: idx.text.slice(Math.max(0, s - CONTEXT), s),
				suffix: idx.text.slice(e, e + CONTEXT),
				offset: s,
			},
		};
		hideFab();
		document.getSelection()?.removeAllRanges();
		activeId = null;
		panelOpen = true;
		paint();
		render();
		list.scrollTop = 0;
		list.querySelector('[data-draft="new"]')?.focus();
	});

	launch.addEventListener("click", () => {
		panelOpen = true;
		render();
	});
	$(".x").addEventListener("click", closePanel);
	$(".resolved-toggle").addEventListener("click", () => {
		showResolved = !showResolved;
		render();
	});

	function closePanel() {
		panelOpen = false;
		activeId = null;
		paint();
		render();
	}

	root.addEventListener("input", (e) => {
		const name = e.target.getAttribute && e.target.getAttribute("data-draft");
		if (name) drafts.set(name, e.target.value);
	});

	root.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			if (draft) {
				draft = null;
				paint();
				render();
			} else closePanel();
			return;
		}
		if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
		const name = e.target.getAttribute && e.target.getAttribute("data-draft");
		if (!name) return;
		e.preventDefault();
		if (name === "new") post();
		else if (name.startsWith("reply:")) reply(name.slice(6));
	});

	function post() {
		const comment = (drafts.get("new") || "").trim();
		if (!comment || !draft) return;
		const anchorData = draft.anchor;
		void mutate(async () => {
			const message = await call("POST", "/api/messages", {
				topic: TOPIC,
				body: rootBody(anchorData.quote, comment),
				tags: [TAG],
				meta: { page: PAGE, anchor: anchorData },
			});
			drafts.delete("new");
			draft = null;
			activeId = message.id;
		});
	}

	function reply(tid) {
		const t = threads.find((x) => x.id === tid);
		const body = (drafts.get("reply:" + tid) || "").trim();
		if (!body || !t) return;
		void mutate(async () => {
			await call("POST", "/api/messages", {
				topic: t.root.topic,
				body,
				tags: [TAG],
				meta: { page: PAGE, thread: tid },
			});
			drafts.delete("reply:" + tid);
		});
	}

	function setStatus(tid) {
		const t = threads.find((x) => x.id === tid);
		if (!t) return;
		// PATCH replaces meta whole, so carry the anchor and anything an agent added.
		const meta = { ...t.root.meta };
		delete meta.resolved_by;
		delete meta.resolved_at;
		if (t.status === "resolved") meta.status = "open";
		else Object.assign(meta, { status: "resolved", resolved_by: VIEWER, resolved_at: Date.now() });
		void mutate(() => call("PATCH", "/api/messages/" + encodeURIComponent(tid), { meta }));
	}

	list.addEventListener("click", (e) => {
		const btn = e.target.closest("[data-act]");
		const card = e.target.closest(".card[data-tid]");
		if (!btn) {
			if (card && card.dataset.tid !== activeId && !e.target.closest("textarea, a")) activate(card.dataset.tid);
			return;
		}
		const { act, tid } = btn.dataset;
		if (act === "focus") activate(tid);
		else if (act === "post") post();
		else if (act === "cancel-new") {
			draft = null;
			drafts.delete("new");
			paint();
			render();
		} else if (act === "reply") reply(tid);
		else if (act === "status") setStatus(tid);
	});

	// Clicking highlighted text on the page opens its thread.
	document.addEventListener("click", (e) => {
		if (inUi(e) || !spans.size) return;
		const sel = document.getSelection();
		if (sel && !sel.isCollapsed) return;
		let node = null;
		let offset = 0;
		if (document.caretPositionFromPoint) {
			const p = document.caretPositionFromPoint(e.clientX, e.clientY);
			if (p) ({ offsetNode: node, offset } = p);
		} else if (document.caretRangeFromPoint) {
			const r = document.caretRangeFromPoint(e.clientX, e.clientY);
			if (r) ({ startContainer: node, startOffset: offset } = r);
		}
		if (!node || !contentRoot().contains(node)) return;
		const at = boundaryToOffset(index(), node, offset);
		let hit = null;
		for (const t of threads) {
			const sp = spans.get(t.id);
			if (!sp || at < sp.s || at > sp.e) continue;
			if (t.status !== "open" && t.id !== activeId) continue;
			if (!hit || sp.e - sp.s < spans.get(hit).e - spans.get(hit).s) hit = t.id;
		}
		if (hit) activate(hit, { scroll: false });
	});

	// Deep links: /p/<page>#m_<id> opens that thread.
	function openFromHash() {
		const id = location.hash.slice(1);
		const t = threads.find((x) => x.id === id);
		if (!t) return;
		if (t.status === "resolved") showResolved = true;
		activate(id);
	}
	window.addEventListener("hashchange", openFromHash);

	// Re-anchor when the page re-renders (Mermaid diagrams, client-rendered HTML).
	let pending = 0;
	const observer = new MutationObserver(() => {
		clearTimeout(pending);
		pending = setTimeout(() => {
			reanchor();
			if (panelOpen) render();
		}, 250);
	});
	observer.observe(document.body, { childList: true, subtree: true, characterData: true });

	render();
	void load().then(openFromHash);
	// Fonts and late renders shift text; re-anchor once things settle.
	void (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => reanchor());
	setInterval(() => {
		const typing = root.activeElement && root.activeElement.tagName === "TEXTAREA";
		if (document.visibilityState === "visible" && !typing && !busy) void load();
	}, POLL_MS);
})();
