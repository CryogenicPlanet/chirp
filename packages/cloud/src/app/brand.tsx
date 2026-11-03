// The chirp marks, drawn as on chirp.wiki (the `#bird` sprite in packages/landing/src/pages.ts).

const inks = {
	chirp: { body: "#ed9b83", wing: "#b9b0df", beak: "#ffd166" },
	claude: { body: "#ff7a3d", wing: "#d4511a", beak: "#ffd166" },
	codex: { body: "#2f6fd6", wing: "#1d4ea3", beak: "#ffd166" },
	instinct: { body: "#ffd93a", wing: "#e0a800", beak: "#ff7a3d" },
	muse: { body: "#ff5fb4", wing: "#d6318a", beak: "#ffd166" },
	hermes: { body: "#a083e8", wing: "#7556c9", beak: "#ffd166" },
	grokbot: { body: "#2eb67a", wing: "#1e8a59", beak: "#ffd166" },
	openclaw: { body: "#ed4b43", wing: "#b32228", beak: "#ffd166" },
} as const;

export type BirdKind = keyof typeof inks;

/**
 * The pixel bird on an 88×80 grid. It is decorative unless it has a `label`, as when a heading ends on a
 * bird instead of a full stop (label ".").
 */
export function Bird({
	kind,
	className,
	label,
}: {
	readonly kind: BirdKind;
	readonly className: string;
	readonly label?: string;
}) {
	const { body, wing, beak } = inks[kind];
	return (
		<svg
			{...(label === undefined ? { "aria-hidden": true } : { "aria-label": label, role: "img" })}
			className={className}
			shapeRendering="crispEdges"
			viewBox="0 0 88 80"
		>
			<path fill={body} d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z" />
			<path fill={wing} d="M24 32h8v8h16v8H24z" />
			<path fill={beak} d="M64 24h16v8H64z" />
			<path fill="#202a3a" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z" />
		</svg>
	);
}

/** The bird and "chirp" in the pixel face, with "Cloud" as a quiet label. */
export function Wordmark() {
	return (
		<span className="inline-flex items-center gap-2 text-ink">
			<Bird kind="chirp" className="h-[26px] w-[29px] shrink-0" />
			<span className="flex items-baseline gap-2">
				<span className="font-pixel text-[24px] leading-none font-semibold">chirp</span>
				<span className="text-[14px] leading-none font-medium text-ink/75">Cloud</span>
			</span>
		</span>
	);
}

// The wire is the curve M-20,26 Q500,70 1020,26 in a 1000×80 box stretched to its container, so x is
// linear in t and the height is a quadratic in t (packages/landing/src/birds.ts).
const wireY = (fraction: number) => {
	const t = (fraction * 1000 + 20) / 1040;
	return (26 + 88 * t * (1 - t)) / 80;
};

/** Birds perched on a sagging wire, evenly spaced. They hop when pointed at, and otherwise sit still. */
export function Wire({ birds, className }: { readonly birds: ReadonlyArray<BirdKind>; readonly className: string }) {
	return (
		<div aria-hidden="true" className={`relative ${className}`}>
			<svg
				className="absolute inset-0 size-full overflow-visible text-ink/75"
				preserveAspectRatio="none"
				viewBox="0 0 1000 80"
			>
				<path
					d="M-20 26 Q500 70 1020 26"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			{birds.map((kind, index) => {
				const fraction = (index + 0.5) / birds.length;
				return (
					<div
						className="absolute -translate-x-1/2 -translate-y-[90%]"
						key={`${kind}-${index}`}
						style={{ left: `${fraction * 100}%`, top: `${wireY(fraction) * 100}%` }}
					>
						<Bird
							kind={kind}
							className="block h-9 w-10 origin-bottom motion-safe:hover:animate-hop max-sm:h-7 max-sm:w-8"
						/>
					</div>
				);
			})}
		</div>
	);
}
