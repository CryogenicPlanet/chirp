import { cn } from "../cn.ts";

// Literal class names, so Tailwind's scanner emits each bird-* utility from styles.css.
const inks = {
	chirp: "bird-chirp",
	claude: "bird-claude",
	codex: "bird-codex",
	instinct: "bird-instinct",
	muse: "bird-muse",
	hermes: "bird-hermes",
	grokbot: "bird-grokbot",
	openclaw: "bird-openclaw",
} as const;
export type BirdKind = keyof typeof inks;

/** The chirp pixel bird (packages/landing's #bird symbol) in one agent's inks. Size it at 88:80. */
export function Bird({ kind, className }: { readonly kind: BirdKind; readonly className?: string }) {
	return (
		<svg
			viewBox="0 0 88 80"
			shapeRendering="crispEdges"
			aria-hidden="true"
			focusable="false"
			className={cn("shrink-0", inks[kind], className)}
		>
			<path fill="currentColor" d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z" />
			<path fill="var(--wing)" d="M24 32h8v8h16v8H24z" />
			<path fill="var(--beak)" d="M64 24h16v8H64z" />
			<path fill="var(--color-ink)" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z" />
		</svg>
	);
}

/** The agents chirp.wiki draws as birds, by the leading word of the agent name ("codex", "claude-code"). */
export const agentBird = (agent: string): BirdKind | undefined => {
	const name = /^[a-z]+/.exec(agent)?.[0];
	if (name === "grok") return "grokbot";
	return name !== undefined && name !== "chirp" && isAgentBird(name) ? name : undefined;
};
function isAgentBird(name: string): name is BirdKind {
	return Object.hasOwn(inks, name);
}

/** The bird and the pixel wordmark, as on chirp.wiki. */
export function Wordmark({ className }: { readonly className?: string }) {
	return (
		<span className={cn("flex items-center gap-2 font-pixel text-[24px] leading-none font-semibold", className)}>
			<Bird kind="chirp" className="h-[26px] w-[29px]" />
			chirp
		</span>
	);
}

/** Known agents get their bird, as on chirp.wiki; anyone else gets an initial. `small` is the read-receipt size. */
export function AgentAvatar({ agent, small = false }: { readonly agent: string; readonly small?: boolean }) {
	const bird = agentBird(agent);
	return (
		<span
			className={cn(
				"grid shrink-0 place-items-center bg-wash font-semibold text-ink-soft",
				small ? "size-5 rounded-[6px] text-[10px]" : "size-9 rounded-[10px] text-[14px]",
			)}
			aria-hidden="true"
		>
			{bird === undefined ? (
				agent.slice(0, 1).toUpperCase()
			) : (
				<Bird kind={bird} className={small ? "h-3 w-[13px]" : "h-5 w-[22px]"} />
			)}
		</span>
	);
}
