"use client";

import Link from "next/link";
import { Layers3 } from "lucide-react";
import { InviteDialog } from "./invite-dialog.tsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AuthButtons } from "./auth-buttons.tsx";
import { Wordmark } from "./brand.tsx";

export interface CloudClientUser {
	readonly id: string;
	readonly name: string;
	readonly email: string;
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
				className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-rule bg-paper/90 px-4 backdrop-blur-md min-[761px]:hidden"
				inert={mobileNavigation && navigationOpen}
			>
				<button
					aria-expanded={navigationOpen}
					aria-label="Open navigation"
					aria-controls="cloud-navigation"
					className="-ml-1.5 grid size-9 cursor-pointer place-content-center gap-[5px] rounded-lg border-0 bg-transparent p-0 hover:bg-wash focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ink"
					onClick={() => setNavigationOpen(true)}
					ref={menu}
					type="button"
				>
					<span className="block h-[1.5px] w-4 bg-ink" />
					<span className="block h-[1.5px] w-4 bg-ink" />
				</button>
				<Wordmark />
			</header>
			<button
				aria-label="Close navigation"
				className={`fixed inset-0 z-[25] block h-auto min-h-0 w-auto border-0 bg-ink/25 p-0 transition-[opacity,visibility] duration-[160ms] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink motion-reduce:transition-none min-[761px]:hidden ${navigationOpen ? "visible opacity-100" : "invisible opacity-0"}`}
				onClick={closeNavigation}
				type="button"
			/>
			<aside
				aria-hidden={mobileNavigation && !navigationOpen}
				className={`fixed inset-y-0 left-0 z-30 flex w-[min(288px,85vw)] flex-col border-r border-rule bg-wash px-[18px] pt-5 pb-5 transition-transform duration-[160ms] focus:outline-none motion-reduce:transition-none min-[761px]:w-56 min-[761px]:translate-x-0 min-[761px]:px-4 min-[761px]:shadow-none min-[1280px]:w-64 min-[1280px]:px-5 ${navigationOpen ? "translate-x-0 shadow-float" : "-translate-x-[101%]"}`}
				id="cloud-navigation"
				inert={mobileNavigation && !navigationOpen}
				ref={sidebar}
				tabIndex={-1}
			>
				<div className="mb-7 flex h-9 items-center px-1">
					<Link
						aria-label="Chirp Cloud home"
						className="rounded-md text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
						href="/"
					>
						<Wordmark />
					</Link>
				</div>
				<nav aria-label="Cloud navigation" className="grid gap-[3px]">
					<Link
						className="flex items-center gap-2.5 rounded-lg bg-card px-2.5 py-2 text-[14.5px] font-medium text-ink no-underline shadow-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
						href="/"
						onClick={closeNavigation}
					>
						<Layers3 aria-hidden="true" className="size-4 text-slate" />
						Boards
					</Link>
				</nav>
				<div className="mt-auto grid gap-4 pt-6">
					<InviteDialog />
					<div className="border-t border-rule pt-3">{user ? <AuthButtons user={user} /> : null}</div>
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
