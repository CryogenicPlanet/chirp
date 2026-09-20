"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AuthButtons } from "./auth-buttons.tsx";

export interface CloudClientUser {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

function Wordmark() {
	return (
		<span className="wordmark">
			<svg aria-hidden="true" viewBox="0 0 24 24">
				<path d="M4 14.5V8l5-4 6 3.5L20 7l-3 3v6.5L12 21l-8-6.5Z" fill="currentColor" />
				<path d="m15 7.5 5-.5-3 3-2-2.5Z" fill="#161b1d" />
				<circle cx="12.5" cy="8.5" fill="#161b1d" r="1" />
			</svg>
			<span>
				chirp<span className="mint-dot">.</span>
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
		<div className="dashboard-shell">
			<header
				aria-hidden={mobileNavigation && navigationOpen}
				className="mobile-header"
				inert={mobileNavigation && navigationOpen}
			>
				<button
					aria-expanded={navigationOpen}
					aria-label="Open navigation"
					aria-controls="cloud-navigation"
					className="menu-button"
					onClick={() => setNavigationOpen(true)}
					ref={menu}
					type="button"
				>
					<span />
					<span />
				</button>
				<Wordmark />
			</header>
			<button
				aria-label="Close navigation"
				className={`nav-scrim${navigationOpen ? " open" : ""}`}
				onClick={closeNavigation}
				type="button"
			/>
			<aside
				aria-hidden={mobileNavigation && !navigationOpen}
				className={`sidebar${navigationOpen ? " open" : ""}`}
				id="cloud-navigation"
				inert={mobileNavigation && !navigationOpen}
				ref={sidebar}
				tabIndex={-1}
			>
				<div>
					<Link aria-label="Chirp Cloud home" href="/">
						<Wordmark />
					</Link>
					<p className="strapline">private managed boards</p>
				</div>
				<nav aria-label="Cloud navigation">
					<Link className="nav-link active" href="/" onClick={closeNavigation}>
						Boards
					</Link>
				</nav>
				<div className="sidebar-account">{user ? <AuthButtons user={user} /> : null}</div>
			</aside>
			<main
				aria-hidden={mobileNavigation && navigationOpen}
				className="dashboard-main"
				inert={mobileNavigation && navigationOpen}
			>
				{children}
			</main>
		</div>
	);
}
