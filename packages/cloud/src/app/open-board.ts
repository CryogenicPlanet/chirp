import { Option, Schema } from "effect";

/** A setup code Cloud already issued for an older board image, shown in the copy-code panel instead of a new one. */
export interface IssuedSetupCode {
	readonly code: string;
	readonly expires_at: string;
}

// The fallback carrying a code is tried first; a malformed code still opens the panel, just empty.
const OpenBoardResponse = Schema.Union([
	Schema.Struct({ url: Schema.String }),
	Schema.Struct({
		fallback: Schema.Literal("setup_code"),
		code: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{16,128}$/)),
		expires_at: Schema.String,
	}),
	Schema.Struct({ fallback: Schema.Literal("setup_code") }),
]);

// URL.canParse is missing from browsers Next still targets (Safari 16.4).
const parse = (value: string) => {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
};

/** Follows only this board's own setup or sign-in page; any other answer is refused rather than navigated to. */
export const openBoardTarget = (
	value: unknown,
	hostname: string,
): { readonly navigate: string } | { readonly setupCode: IssuedSetupCode | undefined } | undefined => {
	const decoded = Schema.decodeUnknownOption(OpenBoardResponse)(value);
	if (Option.isNone(decoded)) return undefined;
	const answer = decoded.value;
	if ("fallback" in answer)
		return {
			setupCode:
				"code" in answer && Number.isFinite(Date.parse(answer.expires_at))
					? { code: answer.code, expires_at: answer.expires_at }
					: undefined,
		};
	const url = parse(answer.url);
	return url &&
		url.protocol === "https:" &&
		url.host === hostname &&
		!url.username &&
		!url.password &&
		(url.pathname === "/setup" || url.pathname === "/auth/login")
		? { navigate: url.href }
		: undefined;
};
