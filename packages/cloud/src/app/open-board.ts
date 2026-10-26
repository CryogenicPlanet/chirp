import { Option, Schema } from "effect";

const OpenBoardResponse = Schema.Union([
	Schema.Struct({ url: Schema.String }),
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
): { readonly navigate: string } | { readonly setupCode: true } | undefined => {
	const decoded = Schema.decodeUnknownOption(OpenBoardResponse)(value);
	if (Option.isNone(decoded)) return undefined;
	if ("fallback" in decoded.value) return { setupCode: true };
	const url = parse(decoded.value.url);
	return url &&
		url.protocol === "https:" &&
		url.host === hostname &&
		!url.username &&
		!url.password &&
		(url.pathname === "/setup" || url.pathname === "/auth/login")
		? { navigate: url.href }
		: undefined;
};
