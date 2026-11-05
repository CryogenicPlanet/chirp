import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

/** A short, non-interactive hint. The trigger must be focusable or wrap a focusable child. */
export function Tooltip({
	content,
	children,
	side = "top",
}: {
	readonly content: ReactNode;
	readonly children: ReactNode;
	readonly side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={side}
					sideOffset={6}
					collisionPadding={8}
					className="z-50 max-w-72 rounded-lg bg-ink px-2.5 py-1.5 text-[12.5px] leading-snug text-white shadow-float data-[state=delayed-open]:animate-[fade-in_100ms_ease-out]"
				>
					{content}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
