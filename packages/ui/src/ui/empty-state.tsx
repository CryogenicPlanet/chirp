import type { ReactNode } from "react";

export function EmptyState({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="rounded-2xl bg-wash px-6 py-10 text-center ring-1 ring-rule">
			<h3 className="text-[15px] font-semibold text-ink">{title}</h3>
			{children !== undefined && (
				<div className="mx-auto mt-1.5 max-w-[52ch] text-[14px] leading-relaxed text-balance text-slate [&_a]:text-ink">
					{children}
				</div>
			)}
		</div>
	);
}
