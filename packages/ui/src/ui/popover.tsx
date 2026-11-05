import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "../cn.ts";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
	className,
	align = "start",
	sideOffset = 8,
	...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				align={align}
				sideOffset={sideOffset}
				collisionPadding={12}
				className={cn(
					"z-50 w-72 rounded-xl bg-card p-1.5 text-ink shadow-float outline-none data-[state=open]:animate-[pop-in_120ms_ease-out]",
					className,
				)}
				{...props}
			/>
		</PopoverPrimitive.Portal>
	);
}
