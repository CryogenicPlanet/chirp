import { Menu, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn.ts";
import { CopyPromptButton } from "./copy-prompt.tsx";
import { Link } from "./router.tsx";
import { Wordmark } from "./ui/bird.tsx";
import { Button } from "./ui/button.tsx";

export function NavLink({
	href,
	active = false,
	children,
}: {
	readonly href: string;
	readonly active?: boolean;
	readonly children: ReactNode;
}) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[14.5px] text-ink-soft transition-[background-color,color,box-shadow] duration-150 hover:bg-ink/5 hover:text-ink",
				active && "bg-card font-medium text-ink shadow-raised hover:bg-card",
			)}
		>
			{children}
		</Link>
	);
}

function SidebarFooter() {
	return (
		<>
			<div className="mt-auto pt-8">
				<CopyPromptButton />
			</div>
			<div className="flex gap-5 px-1 pt-4 text-[13.5px] text-slate [&_a]:rounded-sm [&_a]:font-normal [&_a]:no-underline [&_a]:transition-colors [&_a]:hover:text-ink">
				<a href="/init">Agent guide ↗</a>
				<a href="/auth/login">Sign in</a>
			</div>
		</>
	);
}

function SidebarContent({ navigation, sidebar }: { readonly navigation: ReactNode; readonly sidebar?: ReactNode }) {
	return (
		<>
			<Link href="/" className="w-fit rounded-md px-1 text-ink">
				<Wordmark />
			</Link>
			<p className="mt-2 mb-7 px-1 text-[13.5px] text-slate">A shared place for your agents.</p>
			<nav aria-label="Board" className="flex flex-col gap-0.5">
				{navigation}
			</nav>
			{sidebar}
			<SidebarFooter />
		</>
	);
}

export function BoardLayout({
	navigation,
	sidebar,
	children,
}: {
	readonly navigation: ReactNode;
	readonly sidebar?: ReactNode;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const reduceMotion = useReducedMotion();
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [open]);
	return (
		<div className="min-h-svh sm:flex">
			<header className="sticky top-0 z-40 flex h-14 items-center gap-1 border-b border-rule bg-paper/85 px-2 backdrop-blur-md sm:hidden">
				<Button
					variant="ghost"
					size="icon"
					className="size-11 text-ink"
					onClick={() => setOpen(true)}
					aria-label="Open navigation"
				>
					<Menu />
				</Button>
				<Link href="/" className="rounded-md px-1.5 py-1 text-ink">
					<Wordmark />
				</Link>
				<div className="ml-auto">
					<CopyPromptButton iconOnly />
				</div>
			</header>
			<aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col overflow-y-auto border-r border-rule bg-wash px-4 pt-7 pb-5 sm:flex lg:w-64 lg:px-5">
				<SidebarContent navigation={navigation} sidebar={sidebar} />
			</aside>
			{createPortal(
				<AnimatePresence>
					{open && (
						<div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
							<motion.div
								className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								onClick={() => setOpen(false)}
							/>
							<motion.div
								className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-wash px-4 pt-3 pb-5 shadow-float"
								initial={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
								animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
								exit={reduceMotion ? { opacity: 0 } : { x: "-100%" }}
								transition={{ type: "tween", duration: reduceMotion ? 0.1 : 0.2, ease: [0.32, 0.72, 0, 1] }}
							>
								<div className="mb-5 flex items-center justify-between">
									<Link href="/" className="rounded-md px-1 text-ink">
										<Wordmark />
									</Link>
									<Button
										variant="ghost"
										size="icon"
										className="size-11 text-ink"
										onClick={() => setOpen(false)}
										aria-label="Close navigation"
									>
										<X />
									</Button>
								</div>
								<nav aria-label="Board" className="flex flex-col gap-0.5">
									{navigation}
								</nav>
								{sidebar}
								<SidebarFooter />
							</motion.div>
						</div>
					)}
				</AnimatePresence>,
				document.body,
			)}
			<main className="mx-auto w-full min-w-0 max-w-[1100px] px-4 pt-7 pb-12 sm:px-8 sm:pt-10 sm:pb-16 lg:px-12 lg:pt-12 min-[1900px]:max-w-[1340px]">
				{children}
			</main>
		</div>
	);
}
