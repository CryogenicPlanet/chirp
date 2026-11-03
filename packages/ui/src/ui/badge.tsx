import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

const badgeVariants = cva("inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium wrap-anywhere", {
	variants: {
		variant: {
			default: "rounded-md bg-wash px-1.5 py-0.5 text-ink-soft ring-1 ring-rule",
			count: "rounded-full bg-ink px-1.5 text-[11px] leading-[18px] text-white tabular-nums",
			success: "text-leaf before:size-1.5 before:rounded-full before:bg-current before:content-['']",
			destructive: "text-danger before:size-1.5 before:rounded-full before:bg-current before:content-['']",
		},
	},
	defaultVariants: { variant: "default" },
});

export function Badge({
	className,
	variant,
	...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
