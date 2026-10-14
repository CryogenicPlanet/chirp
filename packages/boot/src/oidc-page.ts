import { authStyles, chirpMark } from "./auth-styles.ts";
import type { AuthError } from "./auth.ts";
import { escape } from "./enrollment-page.ts";
import { humanAgent } from "./human-agent.ts";

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

const already = "That account is already linked to this board.";
const off = "GitHub and Google sign-in is off for this board.";
const ended = "Your board session ended before linking finished. Sign in and start linking again.";
const stranded =
	"No passkey on this board belongs to an address it serves, so linked accounts cannot sign in either. Ask the operator to restore the previous address settings or reopen setup.";
const messages: Readonly<Partial<Record<AuthError["code"], string>>> = Object.freeze({
	identity_not_linked:
		"That account is not linked to this board. Sign in with your passkey, then link it from your account page.",
	identity_exists: already,
	oidc_disabled: off,
	oidc_unavailable: "The sign-in service did not answer. Sign in with your passkey, or try again later.",
	origin_invalid: "This address is no longer allowed for this board.",
	setup_required: "This board has no passkey yet. Create one at /setup first.",
	session_invalid: ended,
	passkey_origin_mismatch: stranded,
});
// Someone linking is already signed in, so a refusal sends them back to the account page, not to sign-in.
const linkMessages: Readonly<Partial<Record<AuthError["code"], string>>> = Object.freeze({
	identity_exists: already,
	oidc_disabled: off,
	oidc_unavailable: "The sign-in service did not answer. Try linking again later.",
	session_invalid: ended,
	passkey_origin_mismatch: stranded,
});

/** canceled: the sign-in service sent the human back with an error, such as declining consent. linking: the refused
 * round trip was a link started from the account page. */
export const oidcErrorPage = (
	code: AuthError["code"],
	options: { readonly canceled: boolean; readonly linking: boolean },
) =>
	options.linking
		? page(
				"Linking refused",
				`<h1>Linking refused</h1><p>${escape(options.canceled ? "Linking was canceled or refused at the sign-in service." : (linkMessages[code] ?? "This link did not verify, expired or was already used. Start linking again from your account page."))}</p><p><a href="/@${humanAgent}">Back to your account</a></p>`,
			)
		: page(
				"Sign-in refused",
				`<h1>Sign-in refused</h1><p>${escape(options.canceled ? "Sign-in was canceled or refused at the sign-in service." : (messages[code] ?? "This sign-in did not verify, expired or was already used. Start again from the sign-in page, in this browser."))}</p><p><a href="/auth/login">Sign in with your passkey</a></p>`,
			);
