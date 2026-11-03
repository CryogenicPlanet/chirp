import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("rounded-[18px] bg-card text-ink shadow-raised", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("flex items-baseline justify-between gap-4 px-5 pt-5 sm:px-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
	return <h2 className={cn("text-[16px] font-semibold tracking-[-0.01em] text-ink", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
	return <div className={cn("px-5 py-5 sm:px-6", className)} {...props} />;
}
