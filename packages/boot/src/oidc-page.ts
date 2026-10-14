import { authStyles, chirpMark } from "./auth-styles.ts";
import type { AuthError } from "./auth.ts";
import { escape } from "./enrollment-page.ts";

/** Nothing on these pages loads, runs or submits; the continue page only navigates within the board. */
export const oidcPageHeaders = Object.freeze({
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
});

const page = (title: string, body: string, head = "") => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${title}</title>
<style>${authStyles}</style>
<main class="auth-shell"><a class="brand" href="/">${chirpMark}chirp<span>.</span></a>${body}</main></html>`;

/** A same-site navigation onward from the cross-site callback. A redirect would continue the issuer's cross-site
 * navigation, and the SameSite=Strict session cookie would not be sent with it. */
export const oidcContinuePage = (next: string) =>
	page(
		"Signing in to chirp",
		`<h1>Signing in</h1><p><a href="${escape(next)}">Continue</a></p>`,
		`<meta http-equiv="refresh" content="0;url=${escape(next)}">`,
	);

const messages: Readonly<Partial<Record<AuthError["code"], string>>> = Object.freeze({
	identity_not_linked:
		"That account is not linked to this board. Sign in with your passkey, then link it from your account page.",
	identity_exists: "That account is already linked to this board.",
	oidc_disabled: "GitHub and Google sign-in is off for this board.",
	oidc_unavailable: "The sign-in service did not answer. Sign in with your passkey, or try again later.",
	origin_invalid: "This address is no longer allowed for this board.",
	setup_required: "This board has no passkey yet. Create one at /setup first.",
	session_invalid: "Your board session ended before linking finished. Sign in and start linking again.",
	passkey_origin_mismatch:
		"No passkey on this board belongs to an address it serves, so linked accounts cannot sign in either. Ask the operator to restore the previous address settings or reopen setup.",
});

/** canceled: the sign-in service sent the human back with an error, such as declining consent. */
export const oidcErrorPage = (code: AuthError["code"], canceled = false) =>
	page(
		"Sign-in refused",
		`<h1>Sign-in refused</h1><p>${escape(canceled ? "Sign-in was canceled or refused at the sign-in service." : (messages[code] ?? "This sign-in did not verify, expired or was already used. Start again from the sign-in page, in this browser."))}</p><p><a href="/auth/login">Sign in with your passkey</a></p>`,
	);
