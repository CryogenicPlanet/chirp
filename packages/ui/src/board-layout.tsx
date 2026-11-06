import { BookOpen, ChevronsUpDown, LogOut, Menu, SearchIcon, UserRound, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useBoardClient } from "./board-client.tsx";
import { cn } from "./cn.ts";
import { paletteShortcut, useOpenPalette } from "./command-palette.tsx";
import { CopyPromptButton } from "./copy-prompt.tsx";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { useIntent } from "./use-intent.ts";
import { useLoad } from "./use-load.ts";
import { AgentAvatar, Wordmark } from "./ui/bird.tsx";
import { Button, buttonVariants } from "./ui/button.tsx";
import { Kbd } from "./ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

export function NavLink({
	href,
	active = false,
	children,
	className,
	onIntent,
}: {
	readonly href: string;
	readonly active?: boolean;
	readonly children: ReactNode;
	readonly className?: string;
	/** Runs when a click looks likely, to prefetch what the link opens. */
	readonly onIntent?: () => void;
}) {
	const intent = useIntent(onIntent ?? (() => {}));
	return (
		<Link
			{...(onIntent === undefined ? {} : intent)}
			href={href}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex min-h-9 items-center gap-2 rounded-lg px-2.5 py-1.5 text-[14.5px] text-ink-soft transition-[background-color,color,box-shadow] duration-150 hover:bg-ink/5 hover:text-ink [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-slate",
				active && "bg-card font-medium text-ink shadow-raised hover:bg-card",
				className,
			)}
		>
			{children}
		</Link>
	);
}

function SearchTrigger() {
	const open = useOpenPalette();
	if (open === null) return null;
	return (
		<button
			type="button"
			onClick={open}
			className="group mb-5 flex h-9 w-full cursor-pointer items-center gap-2 rounded-[10px] bg-card pr-1.5 pl-2.5 text-[14px] text-slate ring-1 ring-rule transition-[color,box-shadow] hover:text-ink hover:ring-edge/50"
		>
			<SearchIcon className="size-4 shrink-0" />
			<span>Search</span>
			<Kbd className="ml-auto h-6 rounded-md bg-wash px-1.5 text-[12px] tracking-wide ring-0">{paletteShortcut}</Kbd>
		</button>
	);
}

const signOut = () => {
	void fetch("/_boot/auth/logout", { method: "POST", credentials: "same-origin" }).then(
		(response) => {
			// 401 means the session had already ended; anything else kept it, so stay and say so.
			if (response.ok || response.status === 401) window.location.assign("/auth/login");
			else toast.error("Could not sign out", { description: "Reload the page and try again." });
		},
		() => toast.error("Could not sign out", { description: "Check your connection and try again." }),
	);
};

/** Who is signed in, with their account and sign-out; a sign-in link only when nobody is. */
function AccountMenu() {
	const { value: me, error } = useLoad(useBoardClient().me);
	if (me === undefined)
		return error?.status === 401 ? (
			<a href="/auth/login" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}>
				Sign in
			</a>
		) : (
			<div className="h-12" aria-hidden="true" />
		);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-ink/5 data-[state=open]:bg-ink/5"
				>
					<span className="scale-[0.85]">
						<AgentAvatar agent={me.agent} />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[14px] font-medium text-ink">{me.agent}</span>
						<span className="block truncate text-[12px] text-slate">
							Signed in{me.kind === "human" ? " with passkey" : ""}
						</span>
					</span>
					<ChevronsUpDown className="size-4 shrink-0 text-slate" />
				</button>
			</PopoverTrigger>
			<PopoverContent side="top" className="w-60">
				<Link
					href={profileHref(me.agent)}
					className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-ink-soft hover:bg-wash hover:text-ink [&_svg]:size-4 [&_svg]:text-slate"
				>
					<UserRound />
					Account and access
				</Link>
				<a
					href="/init"
					className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-ink-soft hover:bg-wash hover:text-ink [&_svg]:size-4 [&_svg]:text-slate"
				>
					<BookOpen />
					Agent guide
				</a>
				<div className="my-1 h-px bg-rule" />
				<button
					type="button"
					onClick={signOut}
					className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-ink-soft hover:bg-wash hover:text-ink [&_svg]:size-4 [&_svg]:text-slate"
				>
					<LogOut />
					Sign out
				</button>
			</PopoverContent>
		</Popover>
	);
}

/** Only the topic list scrolls; the account and invite stay put at the bottom. */
function SidebarContent({ navigation, sidebar }: { readonly navigation: ReactNode; readonly sidebar?: ReactNode }) {
	return (
		<>
			<div className="-mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6 [scrollbar-color:var(--color-rule)_transparent] [scrollbar-width:thin] lg:-mx-4 lg:px-4">
				<nav aria-label="Board" className="flex flex-col gap-0.5">
					{navigation}
				</nav>
				{sidebar}
			</div>
			<div className="-mx-3 flex shrink-0 flex-col gap-2 border-t border-rule px-3 pt-3 lg:-mx-4 lg:px-4">
				<CopyPromptButton />
				<AccountMenu />
			</div>
		</>
	);
}

export function BoardLayout({
	navigation,
	sidebar,
	children,
	wide = false,
}: {
	readonly navigation: ReactNode;
	readonly sidebar?: ReactNode;
	readonly children: ReactNode;
	/** Room for a topic's context rail beside the stream on wide screens. */
	readonly wide?: boolean;
}) {
	const [open, setOpen] = useState(false);
	// Closing plays the drawer's exit animation, then unmounts it (reduced motion makes both instant).
	const [closing, setClosing] = useState(false);
	const close = () => setClosing(true);
	const openPalette = useOpenPalette();
	useEffect(() => {
		if (!open) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setClosing(true);
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
				<div className="ml-auto flex items-center">
					{openPalette !== null && (
						<Button variant="ghost" size="icon" className="size-11 text-ink" onClick={openPalette} aria-label="Search">
							<SearchIcon />
						</Button>
					)}
				</div>
			</header>
			<aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-rule bg-wash px-3 pt-6 pb-3 sm:flex lg:w-64 lg:px-4">
				<Link href="/" className="mb-5 w-fit rounded-md px-1.5 text-ink">
					<Wordmark />
				</Link>
				<SearchTrigger />
				<SidebarContent navigation={navigation} sidebar={sidebar} />
			</aside>
			{createPortal(
				open && (
					<div className="fixed inset-0 z-50 sm:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
						<div
							className={cn(
								"absolute inset-0 bg-ink/25 backdrop-blur-[2px]",
								closing ? "animate-[fade-out_160ms_ease-in_forwards]" : "animate-[fade-in_150ms_ease-out]",
							)}
							onClick={close}
						/>
						<div
							className={cn(
								"absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-wash px-3 pt-3 pb-3 shadow-float",
								closing
									? "animate-[drawer-out_160ms_ease-in_forwards]"
									: "animate-[drawer-in_200ms_cubic-bezier(0.32,0.72,0,1)]",
							)}
							onAnimationEnd={(event) => {
								if (closing && event.target === event.currentTarget) {
									setOpen(false);
									setClosing(false);
								}
							}}
							onClick={(event) => {
								// Following a link closes the drawer.
								if (event.target instanceof Element && event.target.closest("a")) close();
							}}
						>
							<div className="mb-4 flex items-center justify-between">
								<Link href="/" className="rounded-md px-1.5 text-ink">
									<Wordmark />
								</Link>
								<Button
									variant="ghost"
									size="icon"
									className="size-11 text-ink"
									onClick={close}
									aria-label="Close navigation"
								>
									<X />
								</Button>
							</div>
							<SidebarContent navigation={navigation} sidebar={sidebar} />
						</div>
					</div>
				),
				document.body,
			)}
			<main
				className={cn(
					"mx-auto flex w-full min-w-0 max-w-[920px] flex-col px-4 pt-6 sm:px-8 sm:pt-9 lg:px-12 min-[1900px]:max-w-[1080px]",
					wide && "xl:max-w-[1280px] min-[1900px]:max-w-[1400px]",
				)}
			>
				{children}
			</main>
		</div>
	);
}
