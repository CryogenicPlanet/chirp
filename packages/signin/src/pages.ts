import { HttpServerResponse } from "effect/unstable/http";
import type { Identity } from "./upstream.ts";

const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// Self-contained: no scripts, assets or external requests, matching the board's sign-in pages. The CSP loads no
// images and refuses a data: URL too, so there is no favicon. The look is chirp.wiki's, in the system sans.
// "chirp" in Pixelify Sans 600, drawn as a path because these pages load no fonts.
const wordmark =
	`<svg width="60" height="20" viewBox="0 0 2506 817" role="img" aria-label="chirp">` +
	`<path fill="#202a3a" d="M89 647V561H0V262H89V175H385V262H475V385H356V299H118V523H356V436H475V561H385V647ZM597 647V0H715V262H774V175H982V262H1072V647H953V299H804V385H715V647ZM1194 647V175H1312V647ZM1194 125V0H1312V125ZM1434 647V262H1523V175H1819V262H1909V385H1790V299H1552V647ZM2031 817V262H2120V175H2416V262H2506V561H2416V647H2149V817ZM2149 523H2387V299H2149Z"/></svg>`;
const bird =
	`<svg width="31" height="28" viewBox="0 0 88 80" shape-rendering="crispEdges" aria-hidden="true">` +
	`<path fill="#ed9b83" d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z"/>` +
	`<path fill="#b9b0df" d="M24 32h8v8h16v8H24z"/><path fill="#ffd166" d="M64 24h16v8H64z"/>` +
	`<path fill="#202a3a" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z"/></svg>`;
const styles = `
*{box-sizing:border-box}html{background:#f7f5f0}body{margin:0;background:#f7f5f0;color:#202a3a;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid #202a3a;outline-offset:3px}header{padding:24px max(16px,calc(50% - 232px)) 128px;background:#c2dff9}
.brand{display:flex;align-items:center;gap:8px;font-size:24px;font-weight:650;letter-spacing:-.035em;line-height:28px}.brand svg{flex:none}
main{width:min(464px,calc(100% - 32px));margin:-88px auto 48px;padding:32px;background:#fff;border-radius:20px;box-shadow:0 0 0 1px rgb(32 42 58/.07),0 1px 3px rgb(32 42 58/.06),0 6px 16px -6px rgb(32 42 58/.08)}main>:last-child{margin-bottom:0}
h1{margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:-.03em;text-wrap:balance;overflow-wrap:anywhere}p{margin:0 0 16px;color:#3a4558;text-wrap:pretty}strong{color:#202a3a;font-weight:600;overflow-wrap:anywhere}
a{color:#202a3a;text-decoration-color:rgb(32 42 58/.3);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
form{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}button{flex:1 1 160px;min-height:44px;padding:10px 16px;border:0;border-radius:10px;background:#202a3a;color:#fff;font:inherit;font-size:15px;font-weight:500;cursor:pointer}button:hover{background:#3a4558}
button[value=cancel]{background:transparent;color:#202a3a;box-shadow:inset 0 0 0 1px #948d7e}button[value=cancel]:hover{background:#f1eee7}
@media(max-width:600px){header{padding-top:16px;padding-bottom:104px}main{margin-top:-72px;padding:24px 20px}h1{font-size:24px}}
`;

const document = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
	`<title>${escapeHtml(title)}</title><style>${styles}</style></head><body><header><div class="brand">${bird}${wordmark}</div></header><main>${body}</main></body></html>`;

const pageHeaders = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

/** How the consent page names the account. An unverified Google address is never shown. */
export const accountLabel = (identity: Identity) =>
	identity.provider === "github"
		? `${identity.username ?? "your account"} on GitHub`
		: `${identity.email ?? "your Google account"} on Google`;

/** What the board receives, matching the claims the ID token will carry. */
const shared = (identity: Identity) =>
	identity.provider === "github"
		? "GitHub account id and username"
		: identity.email === undefined
			? "Google account id"
			: "Google account id and verified email";

/**
 * Consent once per board: the first sign-in to a client_id and redirect origin asks, and Continue remembers the answer
 * in the provider's session cookie, so later sign-ins there redirect without asking until the session ends. The code
 * goes to the destination, but the ID token's audience is the client_id, and one client document may list callbacks
 * on several origins. When the client_id is on another origin the page names its host too, so a document cannot
 * borrow another board's name unnoticed.
 *
 * form-action must allow the board origin because the browser checks the 303 that follows the POST. The referrer
 * policy is same-origin, not no-referrer: no-referrer makes browsers send `Origin: null` on the form POST, which
 * the consent route refuses.
 */
export const consentPage = (options: {
	readonly destination: string;
	readonly clientId: string;
	readonly identity: Identity;
	readonly csrf: string;
}) => {
	const client = new URL(options.clientId);
	const registered = client.origin === options.destination ? "" : ` (registered by ${client.host})`;
	const target = `${options.destination}${registered}`;
	return HttpServerResponse.text(
		document(
			`Sign in to ${options.destination}`,
			`<h1>Sign in to ${escapeHtml(target)} as ${escapeHtml(accountLabel(options.identity))}?</h1>` +
				`<p>Continue only if you started signing in to <strong>${escapeHtml(target)}</strong>. ` +
				`It will receive your ${shared(options.identity)}.</p>` +
				`<p>chirp will sign you in to <strong>${escapeHtml(target)}</strong> without asking again for up to 30 days. ` +
				`<a href="/signout">Sign out</a> to stop sooner.</p>` +
				`<form method="post" action="/consent"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">` +
				`<button type="submit" name="decision" value="continue">Continue</button>` +
				`<button type="submit" name="decision" value="cancel">Cancel</button></form>`,
		),
		{
			contentType: "text/html; charset=utf-8",
			headers: {
				...pageHeaders,
				"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${options.destination}; frame-ancestors 'none'; base-uri 'none'`,
				"referrer-policy": "same-origin",
			},
		},
	);
};

/** Errors found before the redirect_uri is trusted end here and never redirect. */
export const errorPage = (status: number, message: string) =>
	HttpServerResponse.text(document("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`), {
		status,
		contentType: "text/html; charset=utf-8",
		headers: {
			...pageHeaders,
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
			"referrer-policy": "no-referrer",
		},
	});

/**
 * The sign-out confirmation. Signing out takes this page's POST, so a board cannot sign anyone out with a link. The
 * referrer policy is same-origin for the same reason as the consent page's.
 */
export const signOutPage = HttpServerResponse.text(
	document(
		"Sign out",
		`<h1>Sign out of chirp sign-in?</h1>` +
			`<p>Boards will ask you to sign in with GitHub or Google again. Boards you are signed in to keep their own ` +
			`sessions; sign out on each of them too.</p>` +
			`<form method="post" action="/signout"><button type="submit">Sign out</button></form>`,
	),
	{
		contentType: "text/html; charset=utf-8",
		headers: {
			...pageHeaders,
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			"referrer-policy": "same-origin",
		},
	},
);

export const signedOutPage = HttpServerResponse.text(
	document("Signed out", `<h1>Signed out</h1><p>Your next sign-in to a board goes through GitHub or Google again.</p>`),
	{
		contentType: "text/html; charset=utf-8",
		headers: {
			...pageHeaders,
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
			"referrer-policy": "no-referrer",
		},
	},
);
