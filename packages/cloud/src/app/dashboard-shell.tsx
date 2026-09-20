"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AuthButtons } from "./auth-buttons.tsx";

export interface CloudClientUser {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

function Wordmark({ compact = false }: { readonly compact?: boolean }) {
	return (
		<span
			className={`inline-flex items-center gap-2 font-medium tracking-[-0.035em] ${compact ? "text-[19px]" : "text-2xl"}`}
		>
			<svg
				aria-hidden="true"
				className={`${compact ? "size-[19px]" : "size-[23px]"} text-[#ed9b83]`}
				viewBox="0 0 24 24"
			>
				<path d="M4 14.5V8l5-4 6 3.5L20 7l-3 3v6.5L12 21l-8-6.5Z" fill="currentColor" />
				<path d="m15 7.5 5-.5-3 3-2-2.5Z" fill="#161b1d" />
				<circle cx="12.5" cy="8.5" fill="#161b1d" r="1" />
			</svg>
			<span>
				chirp<span className="text-primary">.</span>
			</span>
		</span>
	);
}

export function DashboardShell({ children, user }: { readonly children: ReactNode; readonly user?: CloudClientUser }) {
	const [navigationOpen, setNavigationOpen] = useState(false);
	const [mobileNavigation, setMobileNavigation] = useState(false);
	const menu = useRef<HTMLButtonElement>(null);
	const restoreMenuFocus = useRef(false);
	const sidebar = useRef<HTMLElement>(null);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 760px)");
		const update = () => setMobileNavigation(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (!navigationOpen) {
			if (restoreMenuFocus.current) {
				restoreMenuFocus.current = false;
				menu.current?.focus();
			}
			return;
		}
		sidebar.current?.focus();
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				restoreMenuFocus.current = true;
				setNavigationOpen(false);
			}
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [navigationOpen]);
	const closeNavigation = () => {
		if (navigationOpen) restoreMenuFocus.current = true;
		setNavigationOpen(false);
	};
	return (
		<div className="min-h-svh">
			<header
				aria-hidden={mobileNavigation && navigationOpen}
				className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-border bg-background/88 px-4 backdrop-blur-sm min-[761px]:hidden"
				inert={mobileNavigation && navigationOpen}
			>
				<button
					aria-expanded={navigationOpen}
					aria-label="Open navigation"
					aria-controls="cloud-navigation"
					className="grid h-[30px] w-7 cursor-pointer place-content-center gap-[5px] rounded-sm border-0 bg-transparent p-0 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					onClick={() => setNavigationOpen(true)}
					ref={menu}
					type="button"
				>
					<span className="block h-px w-[15px] bg-foreground" />
					<span className="block h-px w-[15px] bg-foreground" />
				</button>
				<Wordmark compact />
			</header>
			<button
				aria-label="Close navigation"
				className={`fixed inset-0 z-[25] block h-auto min-h-0 w-auto border-0 bg-foreground/25 p-0 backdrop-blur-[2px] transition-[opacity,visibility] duration-[160ms] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring motion-reduce:transition-none min-[761px]:hidden ${navigationOpen ? "visible opacity-100" : "invisible opacity-0"}`}
				onClick={closeNavigation}
				type="button"
			/>
			<aside
				aria-hidden={mobileNavigation && !navigationOpen}
				className={`fixed inset-y-0 left-0 z-30 flex w-[min(288px,85vw)] flex-col border-r border-border bg-card px-[18px] pt-[26px] pb-5 shadow-elevated transition-transform duration-[160ms] focus:outline-none motion-reduce:transition-none min-[761px]:w-56 min-[761px]:translate-x-0 min-[761px]:px-4 min-[761px]:pt-8 min-[761px]:shadow-none min-[1280px]:w-64 min-[1280px]:px-5 ${navigationOpen ? "translate-x-0" : "-translate-x-[101%]"}`}
				id="cloud-navigation"
				inert={mobileNavigation && !navigationOpen}
				ref={sidebar}
				tabIndex={-1}
			>
				<div>
					<Link
						aria-label="Chirp Cloud home"
						className="text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						href="/"
					>
						<Wordmark />
					</Link>
					<p className="mt-[5px] mr-0 mb-[30px] ml-[31px] font-mono text-[10px] tracking-[0.03em] text-subtle">
						private managed boards
					</p>
				</div>
				<nav aria-label="Cloud navigation" className="grid gap-[3px]">
					<Link
						className="rounded-sm bg-background px-2.5 py-[9px] text-[13px] text-foreground no-underline hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						href="/"
						onClick={closeNavigation}
					>
						Boards
					</Link>
				</nav>
				<div className="mt-auto border-t border-border pt-[18px] [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-[7px]">
					{user ? <AuthButtons user={user} /> : null}
				</div>
			</aside>
			<main
				aria-hidden={mobileNavigation && navigationOpen}
				className="ml-0 w-full px-5 pt-6 pb-12 min-[761px]:ml-56 min-[761px]:w-auto min-[761px]:max-w-[1100px] min-[761px]:px-8 min-[761px]:pt-9 min-[761px]:pb-16 min-[1280px]:ml-64 min-[1280px]:max-w-[1340px] min-[1280px]:px-12 min-[1280px]:pt-11"
				inert={mobileNavigation && navigationOpen}
			>
				{children}
			</main>
		</div>
	);
}
