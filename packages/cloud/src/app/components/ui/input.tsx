import * as React from "react";

import { cn } from "./class-names.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"h-10 w-full min-w-0 rounded-[10px] border border-edge bg-card px-3 text-base text-ink placeholder:text-slate md:text-[15px]",
				"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
				"disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger read-only:bg-wash",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
