import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";

export const buttonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 disabled:cursor-default disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-ink text-white not-disabled:hover:bg-ink-soft",
				outline: "bg-card text-ink shadow-xs ring-1 ring-ink/12 not-disabled:hover:bg-wash",
				ghost: "rounded-lg text-slate not-disabled:hover:bg-wash not-disabled:hover:text-ink",
				destructive: "bg-danger text-white not-disabled:hover:bg-danger/90",
			},
			size: {
				default: "h-10 px-4 text-[14.5px]",
				sm: "h-9 px-3 text-[13.5px]",
				icon: "size-10",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

export function Button({
	className,
	variant,
	size,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
	return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
