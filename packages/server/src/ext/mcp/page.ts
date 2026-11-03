import { createHash } from "node:crypto";

/**
 * The extension's own pages in chirp.wiki's look, matching boot's sign-in and approval pages. The extension cannot
 * import boot, so the marks and styles are copied from packages/boot/src/auth-styles.ts. Nothing loads: the CSP allows
 * only inline styles and, on the one page that has it, a script pinned by its hash, so text is the system sans and the
 * wordmark is a path.
 */
export const escape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
	);

const chirpMark =
	`<svg width="31" height="28" viewBox="0 0 88 80" shape-rendering="crispEdges" aria-hidden="true">` +
	`<path fill="#ed9b83" d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z"/>` +
	`<path fill="#b9b0df" d="M24 32h8v8h16v8H24z"/><path fill="#ffd166" d="M64 24h16v8H64z"/>` +
	`<path fill="#202a3a" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z"/></svg>`;
// "chirp" in Pixelify Sans 600, drawn as a path because these pages load no fonts.
const wordmark =
	`<svg width="60" height="20" viewBox="0 0 2506 817" role="img" aria-label="chirp">` +
	`<path fill="#202a3a" d="M89 647V561H0V262H89V175H385V262H475V385H356V299H118V523H356V436H475V561H385V647ZM597 647V0H715V262H774V175H982V262H1072V647H953V299H804V385H715V647ZM1194 647V175H1312V647ZM1194 125V0H1312V125ZM1434 647V262H1523V175H1819V262H1909V385H1790V299H1552V647ZM2031 817V262H2120V175H2416V262H2506V561H2416V647H2149V817ZM2149 523H2387V299H2149Z"/></svg>`;

const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const styles = `
*{box-sizing:border-box}html{background:#f7f5f0}body{margin:0;padding-bottom:48px;background:#f7f5f0;color:#202a3a;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:rgb(255 227 122/.6)}:focus-visible{outline:2px solid #202a3a;outline-offset:3px}
.sky{padding:24px max(16px,calc(50% - 232px)) 128px;background:#c2dff9}
.brand{display:inline-flex;align-items:center;gap:8px;color:#202a3a;text-decoration:none;border-radius:4px}.brand svg{flex:none}
.auth-shell{width:min(464px,calc(100% - 32px));margin:-88px auto 0;padding:32px;background:#fff;border-radius:20px;box-shadow:0 0 0 1px rgb(32 42 58/.07),0 1px 3px rgb(32 42 58/.06),0 6px 16px -6px rgb(32 42 58/.08)}.auth-shell>:last-child{margin-bottom:0}
h1{margin:0 0 12px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-.03em;text-wrap:balance;overflow-wrap:break-word}
p{margin:0 0 16px;color:#3a4558;text-wrap:pretty;overflow-wrap:break-word}strong{color:#202a3a;font-weight:600;overflow-wrap:anywhere}code{font-family:${mono}}
a{color:#202a3a;text-decoration:underline;text-decoration-color:rgb(32 42 58/.3);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
form{margin:24px 0 0}label{display:block;margin:16px 0 6px;font-size:14px;font-weight:550}
input:not([type=checkbox]){display:block;width:100%;height:44px;padding:0 14px;border:1px solid #948d7e;border-radius:10px;background:#fff;color:#202a3a;font:500 16px ${mono}}input:focus-visible{outline-offset:2px}
button{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;margin:16px 0 0;padding:10px 16px;border:0;border-radius:10px;background:#202a3a;color:#fff;font:inherit;font-size:15px;font-weight:500;line-height:1.3;cursor:pointer}button:hover{background:#3a4558}button:disabled{opacity:.5;cursor:wait}
.secondary{background:transparent;color:#202a3a;box-shadow:inset 0 0 0 1px #948d7e}.secondary:hover{background:#f1eee7}
.name{padding:12px 14px;border-radius:12px;background:#f1eee7}.name summary{display:flex;align-items:baseline;justify-content:space-between;gap:12px;list-style:none;cursor:pointer;border-radius:4px}.name summary::-webkit-details-marker{display:none}
.change{color:#5c6577;font-size:14.5px;text-decoration:underline;text-decoration-color:rgb(92 101 119/.35);text-underline-offset:3px}.name summary:hover .change{color:#202a3a}.name label{margin-top:12px}.hint{margin:6px 0 2px;color:#5c6577;font-size:14px}
.check{display:flex;align-items:flex-start;gap:10px;margin:20px 0 0;font-size:15.5px;font-weight:400;text-wrap:pretty}.check input{flex:none;width:18px;height:18px;margin:3px 0 0;accent-color:#202a3a}
.note{margin:6px 0 0 28px;color:#5c6577;font-size:14.5px}.muted{color:#5c6577;font-size:14.5px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.actions button{flex:1 1 180px;margin:0;white-space:nowrap}
@media(max-width:600px){.sky{padding-top:16px;padding-bottom:104px}.auth-shell{margin-top:-72px;padding:24px 20px}h1{font-size:26px}}
`;

const pinned = (source: string) => ({ source, hash: createHash("sha256").update(source).digest("base64") });
/** The only scripts a page may run, each allowed by its hash. Every page works without them. */
const scripts = {
	/**
	 * The finish page sends its own form, so coming back from boot needs no extra click. The button stays as the way to
	 * finish without scripts; once sent it is disabled, because a second send would find the one-time token spent.
	 */
	finish: pinned(
		`const button=document.getElementById("finish-button");button.disabled=true;button.textContent=button.dataset.busy;document.getElementById("finish").submit();`,
	),
	/**
	 * Consent's posting name sits in a closed details, where Chrome blocks an invalid one without showing it, so an
	 * invalid name opens it. And a send is ignored until the page has been visible and focused for half a second, so a
	 * page that opens consent in a popup under the cursor cannot turn a double click into Connect. The buttons render
	 * enabled and look the same throughout; without scripts the form simply sends.
	 */
	consent: pinned(
		`const agent=document.getElementById("agent");if(agent)agent.addEventListener("invalid",()=>{agent.closest("details").open=true;});const armed={at:Infinity};const arm=()=>{armed.at=document.visibilityState==="visible"&&document.hasFocus()?performance.now()+500:Infinity;};arm();addEventListener("focus",arm);addEventListener("blur",()=>{armed.at=Infinity;});document.addEventListener("visibilitychange",arm);document.getElementById("consent").addEventListener("submit",(event)=>{if(armed.at>performance.now())event.preventDefault();});`,
	),
} as const;

/**
 * A page of the connect flow. `formAction` is where its form may lead: Chromium applies form-action to the redirect
 * after a submit, so it names the client's callback origin as well. A page whose form posts sends no referrer across
 * origins but keeps it within the board: under no-referrer, browsers send `Origin: null` with a form post, which boot
 * refuses.
 */
export const page = (options: {
	readonly title: string;
	readonly body: string;
	readonly formAction: string;
	readonly status?: number;
	readonly script?: keyof typeof scripts;
	readonly head?: string;
}) =>
	new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${options.head ?? ""}<title>${escape(options.title)} · chirp</title><style>${styles}</style></head><body><header class="sky"><a class="brand" href="/">${chirpMark}${wordmark}</a></header><main class="auth-shell">${options.body}</main>${options.script ? `<script>${scripts[options.script].source}</script>` : ""}</body></html>`,
		{
			status: options.status ?? 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": options.formAction === "'none'" ? "no-referrer" : "same-origin",
				"x-content-type-options": "nosniff",
				"content-security-policy": [
					"default-src 'none'",
					"style-src 'unsafe-inline'",
					...(options.script ? [`script-src 'sha256-${scripts[options.script].hash}'`] : []),
					`form-action ${options.formAction}`,
					"base-uri 'none'",
					"frame-ancestors 'none'",
				].join("; "),
			},
		},
	);
