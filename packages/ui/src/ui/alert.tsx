import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

const alertVariants = cva(
	"rounded-xl px-4 py-3.5 text-[14px] leading-relaxed ring-1 [&_h2]:mt-0 [&_h2]:mb-1 [&_h2]:text-[15px] [&_h2]:font-semibold [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
	{
		variants: {
			variant: {
				// A highlighter-yellow note: needs attention, nothing is broken.
				warning: "bg-marker/30 text-ink ring-marker",
				destructive: "bg-card text-danger ring-danger/35",
			},
		},
		defaultVariants: { variant: "warning" },
	},
);

export function Alert({
	className,
	variant,
	...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
	return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
