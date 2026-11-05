import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn.ts";

/** shadcn-style wrappers around cmdk in the board's tokens. */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive className={cn("flex h-full w-full flex-col overflow-hidden text-ink", className)} {...props} />
	);
}

export function CommandDialog({
	open,
	onOpenChange,
	label,
	children,
	shouldFilter,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly label: string;
	readonly children: ReactNode;
	readonly shouldFilter?: boolean;
}) {
	return (
		<CommandPrimitive.Dialog
			open={open}
			onOpenChange={onOpenChange}
			label={label}
			loop
			{...(shouldFilter === undefined ? {} : { shouldFilter })}
			overlayClassName="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]"
			contentClassName="fixed top-[12vh] left-1/2 z-50 flex max-h-[min(560px,76vh)] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-card shadow-float data-[state=open]:animate-[pop-in_140ms_cubic-bezier(0.32,0.72,0,1)]"
		>
			{children}
		</CommandPrimitive.Dialog>
	);
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div className="flex items-center gap-2.5 border-b border-rule px-4">
			<SearchIcon className="size-4 shrink-0 text-slate" aria-hidden="true" />
			<CommandPrimitive.Input
				className={cn(
					"h-13 w-full bg-transparent text-[15.5px] text-ink outline-none placeholder:text-slate focus-visible:outline-none",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			className={cn("min-h-0 flex-1 scroll-py-2 overflow-y-auto overscroll-contain p-2", className)}
			{...props}
		/>
	);
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty className={cn("px-3 py-8 text-center text-[14px] text-slate", className)} {...props} />
	);
}

export function CommandLoading({ className, ...props }: ComponentProps<typeof CommandPrimitive.Loading>) {
	return <CommandPrimitive.Loading className={cn("px-3 py-2 text-[13px] text-slate", className)} {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			className={cn(
				"py-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-slate",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			className={cn(
				"flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14.5px] text-ink-soft select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-wash data-[selected=true]:text-ink [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-slate",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
	return <CommandPrimitive.Separator className={cn("mx-2 my-1 h-px bg-rule", className)} {...props} />;
}

/** A keyboard key, as in ⌘K. */
export function Kbd({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-card px-1 font-sans text-[11.5px] font-medium text-slate ring-1 ring-rule",
				className,
			)}
		>
			{children}
		</kbd>
	);
}
