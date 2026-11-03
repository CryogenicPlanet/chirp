import type { ReactNode } from "react";

export function PageHeader({
	breadcrumb,
	title,
	description,
	actions,
}: {
	readonly breadcrumb: ReactNode;
	readonly title: ReactNode;
	readonly description?: ReactNode;
	readonly actions?: ReactNode;
}) {
	return (
		<header className="mb-8 flex items-start justify-between gap-4 sm:mb-10 sm:items-center">
			<div className="min-w-0">
				<nav
					className="mb-2 text-[13.5px] wrap-anywhere text-slate sm:mb-3 [&_a]:rounded-sm [&_a]:font-normal [&_a]:no-underline [&_a]:transition-colors [&_a]:hover:text-ink"
					aria-label="Breadcrumb"
				>
					{breadcrumb}
				</nav>
				<h1 className="text-[28px] leading-[1.1] font-[650] tracking-[-0.035em] wrap-anywhere sm:text-[34px]">
					{title}
				</h1>
				{description !== undefined && (
					<p className="mt-2.5 max-w-[60ch] text-[15px] leading-relaxed text-slate">{description}</p>
				)}
			</div>
			{actions}
		</header>
	);
}
