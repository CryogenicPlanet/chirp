import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "./class-names.ts";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-[10px] font-medium whitespace-nowrap cursor-pointer transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "bg-ink text-white hover:bg-ink-soft",
				destructive: "bg-danger text-white hover:bg-danger/90",
				outline: "bg-card text-ink ring-1 ring-edge ring-inset hover:bg-wash",
				ghost: "rounded-lg text-slate hover:bg-wash hover:text-ink",
				link: "text-ink underline decoration-ink/25 underline-offset-4 hover:decoration-ink",
			},
			size: {
				default: "h-10 px-4 text-[14.5px] has-[>svg]:px-3.5",
				sm: "h-8 gap-1.5 px-3 text-[13.5px] has-[>svg]:px-2.5",
				lg: "h-11 px-5 text-[15.5px] has-[>svg]:px-4",
				"icon-sm": "size-8 rounded-lg",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
