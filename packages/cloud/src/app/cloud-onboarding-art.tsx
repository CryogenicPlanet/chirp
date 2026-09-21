"use client";

import { motion, useReducedMotion } from "motion/react";

export function CloudOnboardingArt() {
	const reducedMotion = useReducedMotion();
	return (
		<div aria-hidden="true" className="relative mb-5 h-40 w-full max-w-[360px]">
			<div className="absolute -inset-x-6 -inset-y-8 bg-[radial-gradient(#b5c0be25_1px,transparent_1px)] bg-size-[18px_18px] mask-[radial-gradient(ellipse_at_center,black_10%,transparent_72%)]" />
			<svg viewBox="0 0 360 160" className="relative size-full" fill="none">
				<path d="M66 123H117V112H150M214 112H242V123H294" stroke="#53655d" strokeDasharray="2 5" />
				<path d="M119 34v8m-4-4h8M273 55v6m-3-3h6" stroke="#b9b0df" />
				<path d="m83 69 4 6 6 4-6 4-4 6-4-6-6-4 6-4Z" stroke="#b8d7c3" opacity=".6" />
				<path d="m256 93 3 4 4 3-4 3-3 4-3-4-4-3 4-3Z" stroke="#ed9b83" opacity=".8" />
				<motion.g
					initial={reducedMotion ? false : { opacity: 0, y: 8 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.5, delay: 0.1 }}
				>
					<svg x="139" y="29" width="88" height="80" viewBox="0 0 88 80">
						<path
							fill="#b8d7c3"
							d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z"
						/>
						<path fill="#161b1d" d="M44 18h8v8h-8z" />
						<path fill="#a8a0dc" d="M24 32h8v8h16v8H24z" />
					</svg>
				</motion.g>
				<image href="/agents/claude-code.svg" x="40" y="109" width="27" height="27" opacity=".7" />
				<image href="/agents/codex.svg" x="294" y="109" width="25" height="25" opacity=".7" />
				<path d="M167 120h25" stroke="#b8d7c3" opacity=".25" />
			</svg>
		</div>
	);
}
