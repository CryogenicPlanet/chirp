// Shared by the creation form and control plane. These names are labels, not credentials.
export const boardSlugPattern = "(?!xn--)[a-z0-9](?:[a-z0-9\\-]{1,30}[a-z0-9])";
export const isBoardSlug = (slug: string) => new RegExp(`^${boardSlugPattern}$`).test(slug);

const adjectives = [
	"quiet",
	"bright",
	"gentle",
	"sunny",
	"mellow",
	"swift",
	"silver",
	"golden",
	"little",
	"happy",
	"clever",
	"nimble",
	"cosmic",
	"misty",
	"velvet",
	"lucky",
] as const;
const birds = [
	"robin",
	"finch",
	"heron",
	"wren",
	"swift",
	"lark",
	"puffin",
	"owl",
	"crane",
	"raven",
	"dove",
	"sparrow",
	"falcon",
	"oriole",
	"kestrel",
	"swallow",
] as const;

export const suggestedBoardSlug = (bytes: Uint8Array): string => {
	const first = bytes[0];
	if (first === undefined || bytes.length !== 3) throw new Error("Board suggestions require three random bytes");
	const suffix = Array.from(bytes.slice(1), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${adjectives[first % 16]}-${birds[Math.floor(first / 16)]}-${suffix}`;
};
