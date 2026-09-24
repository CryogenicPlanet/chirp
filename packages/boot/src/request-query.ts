/** Request records keep query parameter names, and values only when they cannot be credentials.
 * OAuth state, one-time codes and tokens travel in URLs, and a stored record outlives its request. */
const redacted = "[redacted]";
const maxParameters = 32,
	maxName = 64,
	maxValue = 256,
	maxTotal = 2048;
// Matching is by word, so `code` covers `code` and `user_code` while `code_challenge_method` stays readable.
const secretWords: readonly string[] = Object.freeze([
	"assertion",
	"auth",
	"authorization",
	"bearer",
	"cookie",
	"credential",
	"credentials",
	"hmac",
	"jwt",
	"key",
	"nonce",
	"otp",
	"pass",
	"passcode",
	"passwd",
	"password",
	"pin",
	"private",
	"pwd",
	"secret",
	"session",
	"sid",
	"sig",
	"signature",
	"state",
	"ticket",
	"token",
	"verifier",
]);
// Joined names such as `accesstoken` or `clientsecret` have no word boundary.
const secretFragments: readonly string[] = Object.freeze([
	"apikey",
	"cookie",
	"credential",
	"nonce",
	"passw",
	"secret",
	"session",
	"signature",
	"token",
]);
// OAuth names the client, its redirect and the protected resource publicly; a failed authorization turns on them.
const publicNames: readonly string[] = Object.freeze(["client_id", "redirect_uri", "resource"]);

const words = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
const secretName = (name: string) => {
	const parts = words(name);
	const joined = parts.join("");
	return (
		parts.at(-1) === "code" ||
		parts.some((part) => secretWords.includes(part)) ||
		secretFragments.some((fragment) => joined.includes(fragment))
	);
};
// Keys and tokens are long runs mixing letter case or digits; readable URLs, paths and words are not.
const credentialShaped = (text: string) =>
	(text.match(/[A-Za-z0-9_+=-]{20,}/g) ?? []).some(
		(run) => [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(run)).length >= 2,
	);
// A URL inside a value can carry its own query, fragment or userinfo. URL parsers also accept scheme-relative
// `//user:pass@host`, backslashes and extra slashes, and `@` inside the password, splitting at the last `@`.
const withoutNested = (value: string) => {
	const cut = value.search(/[?#]/);
	return cut < 0 ? value : `${value.slice(0, cut)}${value.charAt(cut)}${redacted}`;
};
const userinfo = /^(\s*(?:[a-z][a-z0-9+.-]*:)?[\\/]{2,})[^\\/?#]*@/i;
// Special schemes also take userinfo after zero or one slash (`https:user:pass@host`), and parsers drop tabs,
// newlines and leading controls. The check removes only the userinfo matched above, never text the input
// supplied, and whatever the URL parser still reads as userinfo drops the whole value.
const parsedUserinfo = (value: string) => {
	const url = URL.parse(value.replace(userinfo, "$1"), "http://base.invalid");
	return url !== null && (url.username !== "" || url.password !== "");
};
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const storedValue = (name: string, value: string) => {
	if (secretName(name)) return redacted;
	const url = withoutNested(value);
	if (parsedUserinfo(url)) return redacted;
	const readable = url.replace(userinfo, `$1${redacted}@`);
	return !publicNames.includes(name) && credentialShaped(readable) ? redacted : clip(readable, maxValue);
};

/** The payload fields describing a URL query: ordered [name, value] pairs, bounded in count and size. */
export const requestQuery = (
	search: string,
): { readonly query?: ReadonlyArray<readonly [string, string]>; readonly query_truncated?: true } => {
	const parameters = [...new URLSearchParams(search)];
	const pairs = parameters
		.slice(0, maxParameters)
		.map(([name, value]): readonly [string, string] => [
			credentialShaped(name) ? redacted : clip(name, maxName),
			storedValue(name, value),
		]);
	const totals = pairs.map(([name, value]) => name.length + value.length);
	const kept = pairs.filter((_, index) => totals.slice(0, index + 1).reduce((sum, size) => sum + size, 0) <= maxTotal);
	return {
		...(kept.length === 0 ? {} : { query: kept }),
		...(kept.length < parameters.length ? { query_truncated: true } : {}),
	};
};
