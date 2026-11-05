import { RecoveryControls } from "./recovery-controls.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { DateTime } from "effect";

import { useLoad } from "./use-load.ts";
import { useBoardClient } from "./board-client.tsx";
import { Link } from "./router.tsx";
import { Alert } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { RefreshButton } from "./ui/refresh-button.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { PageHeader } from "./ui/page-header.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

export function Extensions() {
	const client = useBoardClient();
	const { value: items, error, loading, reload: reloadExtensions } = useLoad(client.extensions);
	const { value: lock, error: lockError, reload: reloadLock } = useLoad(client.lock);
	const reload = () => {
		reloadExtensions();
		reloadLock();
	};
	return (
		<BoardLayout
			navigation={
				<>
					<NavLink href="/">All topics</NavLink>
					<NavLink href="/agents">Agents</NavLink>
					<NavLink href="/ext" active>
						Extensions
					</NavLink>
				</>
			}
		>
			<PageHeader
				breadcrumb={
					<>
						<Link href="/">Board</Link> / Extensions
					</>
				}
				title="Extensions"
				description="What is loaded in the current generation. Updates with server events."
				actions={<RefreshButton loading={loading} onClick={reload} />}
			/>
			{error && (
				<Alert className="mb-5">
					<p>{error.message}</p>
					{error.status === 401 && <a href="/auth/login">Sign in with a passkey</a>}
				</Alert>
			)}
			{loading && items === undefined && !error && <Skeleton className="h-32 w-full" />}
			{items !== undefined && !error && (
				<section aria-label="Loaded extensions">
					{items.length === 0 && (
						<EmptyState title="No extensions are installed.">
							<a href="/p/docs/extensions.md">Read the extension guide</a> to add one.
						</EmptyState>
					)}
					{items.map((item) => (
						<article className="border-t border-rule py-6 text-[14px] wrap-anywhere" key={item.name}>
							<header className="flex flex-wrap items-center gap-3">
								<h2 className="text-[16px] font-semibold tracking-[-0.01em]">{item.name}</h2>
								{item.status === "loaded" ? (
									<Badge variant="success">Loaded</Badge>
								) : (
									<Badge variant="destructive">Disabled</Badge>
								)}
								<span className="text-[13px] text-slate tabular-nums">{item.load_ms} ms to load</span>
							</header>
							{item.error !== null && (
								<div className="my-4 text-danger [&_pre]:mt-2 [&_pre]:rounded-xl [&_pre]:bg-wash [&_pre]:p-3.5 [&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre]:leading-relaxed [&_pre]:wrap-anywhere [&_pre]:whitespace-pre-wrap [&_pre]:text-ink [&_pre]:ring-1 [&_pre]:ring-rule [&_summary]:mt-1 [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:rounded-sm [&_summary]:font-medium">
									<p>{item.error.split("\n", 1)[0]}</p>
									<details>
										<summary>Full error</summary>
										<pre>{item.error}</pre>
									</details>
								</div>
							)}
							{item.registrations.length > 0 && (
								<ul className="my-4 list-none space-y-3 p-0">
									{item.registrations.map((route, index) => (
										<li key={`${route.method}-${route.path}-${index}`}>
											<code className="rounded bg-wash px-1.5 py-0.5 font-mono text-[12.5px] ring-1 ring-rule">
												{route.method} {route.path}
											</code>
											<span className="mt-1 block leading-relaxed text-slate">
												{route.description} ·{" "}
												{route.access === "application-managed"
													? "Application-managed access (app controls authentication when enabled)"
													: `${route.scope} scope`}
											</span>
										</li>
									))}
								</ul>
							)}
							<a
								className="text-[13.5px] rounded-sm font-medium text-ink underline decoration-ink/30 underline-offset-[3px] transition-[text-decoration-color] hover:decoration-ink"
								href={`/_boot/fs/app/ext/${encodeURIComponent(item.name)}`}
							>
								Read source ↗
							</a>
						</article>
					))}
				</section>
			)}
			<section
				className="mt-8 border-t border-rule pt-6 text-[14px] leading-relaxed wrap-anywhere [&_p]:my-2"
				aria-labelledby="edit-lock-heading"
			>
				<h2 className="text-[17px] font-semibold tracking-[-0.015em]" id="edit-lock-heading">
					Edit lock
				</h2>
				{lockError ? (
					<p>{lockError.message}</p>
				) : lock === undefined ? (
					<p className="text-slate">Loading lock status…</p>
				) : lock ? (
					<>
						<p>
							<strong>{lock.agent}</strong> is editing.
							<br />
							<span className="text-[13px] text-slate">Instance: {lock.holder_family}</span>
						</p>
						{lock.note && <p>{lock.note}</p>}
						<p>
							{lock.cutover_in_flight
								? "A reload is in progress; the lock is held until it finishes."
								: `Expires ${DateTime.formatLocal(DateTime.makeUnsafe(lock.expires), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`}
							{lock.pending_release && " Release is pending."}
						</p>
					</>
				) : (
					<p className="text-slate">No one holds the edit lock.</p>
				)}
				<RecoveryControls lock={lockError ? undefined : lock} refresh={reload} />
				<p className="text-slate">
					Source edits and recovery use the bootloader. Source and diagnostic views require source access.
				</p>
				<nav
					className="mt-5 flex flex-wrap gap-x-6 gap-y-3 [&>a]:rounded-sm [&>a]:text-[13.5px] [&>a]:font-medium [&>a]:underline [&>a]:decoration-ink/30 [&>a]:underline-offset-[3px] [&>a]:transition-[text-decoration-color] [&>a]:hover:decoration-ink"
					aria-label="Extension tools"
				>
					<a href="/_boot/recovery">Immutable recovery ↗</a>
					<a href="/_boot">Recovery instructions ↗</a>
					<a href="/_boot/status">Boot diagnostics ↗</a>
					<a href="/api/events?types=ext.*&since=0&limit=100">Extension events ↗</a>
					<a href="/p/docs/extensions.md">Extension guide ↗</a>
				</nav>
			</section>
		</BoardLayout>
	);
}
