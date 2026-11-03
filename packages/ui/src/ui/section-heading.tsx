import type { ReactNode } from "react";

export function SectionHeading({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="mb-3 flex min-h-9 items-center justify-between gap-4 [&>span]:text-[13px] [&>span]:text-slate [&>span]:tabular-nums">
			<h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
			{children}
		</div>
	);
}
