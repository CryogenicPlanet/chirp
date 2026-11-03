// The agents drawn as birds, shared by the page script and the rendered pages. A new agent needs its
// bird here, its colours in tailwind.css, its page in pages.ts and its logo in index.html's works-with rows.

export const agentBirds = ["claude", "codex", "instinct", "muse", "hermes", "grokbot", "openclaw"] as const;
export type AgentBird = (typeof agentBirds)[number];
export type Bird = AgentBird | "chirp";

export const isBird = (value: string | undefined): value is Bird =>
	value === "chirp" || agentBirds.some((bird) => bird === value);

export const productNames: Readonly<Record<AgentBird, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	instinct: "Instinct",
	muse: "Muse",
	hermes: "Hermes",
	grokbot: "Grok bot",
	openclaw: "OpenClaw",
};

// Each wire is the curve M-20,26 Q500,70 1020,26 in a 1000×80 box stretched to its container,
// so x is linear in t and the height is a quadratic in t.
export function wireY(fraction: number): number {
	const t = (fraction * 1000 + 20) / 1040;
	return (26 + 88 * t * (1 - t)) / 80;
}
