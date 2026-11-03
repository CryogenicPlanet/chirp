import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../cn.ts";

const fieldClass =
	"w-full min-w-0 rounded-[10px] border border-edge bg-card px-3 text-[15px] text-ink transition-colors placeholder:text-slate focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:bg-wash disabled:text-ink-soft aria-invalid:border-danger";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={cn(fieldClass, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={cn(fieldClass, "resize-y py-2 leading-relaxed", className)} {...props} />;
}

/** A sentence-case field label. */
export const labelClass = "mt-4 mb-1.5 block text-[13.5px] font-medium text-slate";
/** Help text under a field. */
export const hintClass = "mt-1.5 text-[13px] leading-relaxed text-slate";
