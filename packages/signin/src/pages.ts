import { HttpServerResponse } from "effect/unstable/http";
import type { Identity } from "./upstream.ts";

const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// Self-contained: no scripts, assets or external requests, matching the board's sign-in pages.
const styles = `
*{box-sizing:border-box}body{margin:0;background:#161b1d;color:#eeeee7;font:16px/1.65 system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:32rem;margin:10vh auto;padding:1.5rem}
.brand{font-size:1.1rem;font-weight:650;letter-spacing:-.04em;color:#e69b83}
h1{font:normal clamp(2rem,5vw,3rem)/1.15 Georgia,serif;letter-spacing:-.03em;margin:2rem 0 1rem;overflow-wrap:anywhere}p{margin-top:0;color:#a8b4b4}strong{color:#eeeee7;overflow-wrap:anywhere}
form{display:flex;gap:.75rem;margin-top:1.5rem}button{flex:1;font:inherit;font-weight:550;padding:.75rem 1rem;border-radius:4px;border:0;cursor:pointer;background:#b8d7c3;color:#17201d}
button[value=cancel]{background:transparent;color:#eeeee7;border:1px solid #52625e}button:focus-visible{outline:2px solid #c9bfdf;outline-offset:4px}
@media(max-width:600px){main{margin:4vh auto}}
`;

const document = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
	`<title>${escapeHtml(title)}</title><style>${styles}</style></head><body><main><div class="brand">chirp sign-in</div>${body}</main></body></html>`;

const pageHeaders = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
};

/** How the consent page names the account. An unverified Google address is never shown. */
export const accountLabel = (identity: Identity) =>
	identity.provider === "github"
		? `${identity.username ?? "your account"} on GitHub`
		: `${identity.email ?? "your Google account"} on Google`;

/**
 * Consent on every sign-in. form-action must allow the board origin because the browser checks the 303 that
 * follows the POST. The referrer policy is same-origin, not no-referrer: no-referrer makes browsers send
 * `Origin: null` on the form POST, which the consent route refuses.
 */
export const consentPage = (options: {
	readonly destination: string;
	readonly identity: Identity;
	readonly csrf: string;
}) =>
	HttpServerResponse.text(
		document(
			`Sign in to ${options.destination}`,
			`<h1>Sign in to ${escapeHtml(options.destination)} as ${escapeHtml(accountLabel(options.identity))}?</h1>` +
				`<p>Continue only if you started signing in to <strong>${escapeHtml(options.destination)}</strong>. ` +
				`It will receive your ${options.identity.provider === "github" ? "GitHub account id and username" : "Google account id and verified email"}.</p>` +
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
