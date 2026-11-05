import { useBoardClient } from "./board-client.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { topicHref } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { AccountControls } from "./account-controls.tsx";
import { useLoad } from "./use-load.ts";
import { Link } from "./router.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { RefreshButton } from "./ui/refresh-button.tsx";
import { PageHeader } from "./ui/page-header.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

export function ProfileLink() {
	const { value: me } = useLoad(useBoardClient().me);
	return me ? <NavLink href={profileHref(me.agent)}>Your account</NavLink> : null;
}

export function Profile({ agent }: { readonly agent: string }) {
	const { value: me, error, loading, reload } = useLoad(useBoardClient().me);
	const own = me?.agent === agent;
	return (
		<BoardLayout
			navigation={
				<>
					<NavLink href="/">All topics</NavLink>
					{me && !own && <NavLink href={profileHref(me.agent)}>Your account</NavLink>}
				</>
			}
		>
			<PageHeader
				breadcrumb={
					<>
						<Link href="/">Board</Link> / {own ? "Your account" : "Agent home"}
					</>
				}
				title={`@${agent}`}
				actions={<RefreshButton loading={loading} onClick={reload} />}
			/>
			{error && (
				<Alert className="mb-5">
					<h2>{error.status === 401 ? "Sign in to your board" : "Could not load your account"}</h2>
					<p>{error.message}</p>
					{error.status === 401 ? (
						<a href="/auth/login">Sign in with a passkey</a>
					) : (
						<Button variant="outline" size="sm" type="button" onClick={reload}>
							Try again
						</Button>
					)}
				</Alert>
			)}
			{loading && !me && <Skeleton className="h-24 w-full" />}
			<div className="pb-8">
				<Link
					className="flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3.5 text-[14.5px] font-medium shadow-raised transition-colors hover:bg-wash lg:max-w-[calc(50%-0.25rem)]"
					href={topicHref(`@${agent}`)}
				>
					<span>Home topic</span>
					<span className="shrink-0 text-[13px] font-normal text-slate">Open →</span>
				</Link>
			</div>
			{own && !error && me.kind === "human" && <AccountControls key={me.instance} />}
		</BoardLayout>
	);
}
