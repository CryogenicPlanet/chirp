import { DateTime, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { accountRequest, getFamilies, unreadable, type FamilyList } from "./account-api.ts";
import { BoardError } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { useLoad } from "./use-load.ts";
import { Alert } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { PageHeader } from "./ui/page-header.tsx";
import { SectionHeading } from "./ui/section-heading.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

const day = 86_400_000;
const Activity = Schema.Struct({
	as_of: Schema.Int,
	items: Schema.Array(
		Schema.Struct({
			agent: Schema.String,
			posts: Schema.Int,
			posts_24h: Schema.Int,
			posts_7d: Schema.Int,
			last_post_at: Schema.Int,
			mcp: Schema.Boolean,
		}),
	),
});
type Activity = typeof Activity.Type;

interface AgentRow {
	readonly agent: string;
	readonly labels: ReadonlyArray<string>;
	readonly joined: number | null;
	readonly lastActive: number | null;
	readonly connected: boolean;
	readonly mcp: boolean;
	readonly posts: number;
	readonly posts24h: number;
	readonly posts7d: number;
}

// Each source fails on its own, so a missing extension or an expired session still leaves the other half visible.
const getActivity = () =>
	accountRequest(HttpClientRequest.get(new URL("/api/agents/activity", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Activity)),
		Effect.catchTag("SchemaError", () => unreadable),
		Effect.mapError(
			(error) =>
				new BoardError({
					status: error.status,
					message:
						error.status === 404
							? "Post counts need the agents extension (app/ext/agents.ts), which is not loaded."
							: "Post counts could not be loaded. Refresh to try again.",
				}),
		),
	);
const getTokens = () =>
	getFamilies().pipe(
		Effect.mapError(
			(error) =>
				new BoardError({
					status: error.status,
					message:
						error.status === 401 || error.status === 403
							? "Sign in with your passkey to see when agents joined and were last active."
							: "Agent tokens could not be loaded, so join and last-active times are missing. Refresh to try again.",
				}),
		),
	);

const latest = (values: ReadonlyArray<number | null>) =>
	values.reduce<number | null>(
		(best, value) => (value !== null && (best === null || value > best) ? value : best),
		null,
	);

/** One row per agent name: token families say when it joined and last authenticated; messages say how much it posts. */
const rows = (
	families: FamilyList["items"],
	activity: Activity["items"],
	now: number,
	hidden: ReadonlySet<string>,
): ReadonlyArray<AgentRow> => {
	const names = new Set([...families.map((family) => family.agent), ...activity.map((item) => item.agent)]);
	return [...names]
		.filter((agent) => !hidden.has(agent))
		.map((agent) => {
			const owned = families.filter((family) => family.agent === agent);
			const posted = activity.find((item) => item.agent === agent);
			return {
				agent,
				labels: [...new Set(owned.map((family) => family.label))],
				joined: owned.length === 0 ? null : Math.min(...owned.map((family) => family.created_at)),
				lastActive: latest([...owned.map((family) => family.last_used_at), posted?.last_post_at ?? null]),
				connected: owned.some(
					(family) => !family.revoked && (family.refresh_expires_at === null || family.refresh_expires_at > now),
				),
				mcp: posted?.mcp ?? false,
				posts: posted?.posts ?? 0,
				posts24h: posted?.posts_24h ?? 0,
				posts7d: posted?.posts_7d ?? 0,
			};
		})
		.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
};

const ago = (at: number | null, now: number) => {
	if (at === null) return "Never";
	const minutes = Math.floor((now - at) / 60_000);
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
	if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
	return DateTime.formatLocal(DateTime.makeUnsafe(at), { month: "short", day: "numeric", year: "numeric" });
};
const date = (at: number | null) =>
	at === null
		? "—"
		: DateTime.formatLocal(DateTime.makeUnsafe(at), { month: "short", day: "numeric", year: "numeric" });

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
	return (
		<div className="rounded-md border border-border bg-card px-4 py-3.5">
			<p className="text-[11px] text-muted-foreground">{label}</p>
			<p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
		</div>
	);
}

export function Agents() {
	const client = useBoardClient();
	const me = useLoad(client.me);
	const tokensRequest = useMemo(() => getTokens(), []);
	const activityRequest = useMemo(() => getActivity(), []);
	const tokens = useLoad(tokensRequest);
	const activity = useLoad(activityRequest);
	const loading = tokens.loading || activity.loading;
	const reload = () => {
		tokens.reload();
		activity.reload();
	};
	const settled = [me, tokens, activity].every((load) => load.value !== undefined || load.error);
	const errors = [tokens.error, activity.error].filter((error) => error !== undefined && error !== null);
	// oxlint-disable-next-line effecttsgo/global-date -- a render-time clock is enough when the activity snapshot is missing.
	const now = activity.value?.as_of ?? Date.now();
	const hidden = new Set(["system", ...(me.value?.kind === "human" ? [me.value.agent] : [])]);
	const agents =
		settled && (tokens.value || activity.value)
			? rows(tokens.value?.items ?? [], activity.value?.items ?? [], now, hidden)
			: undefined;
	return (
		<BoardLayout
			navigation={
				<>
					<NavLink href="/">All topics</NavLink>
					<NavLink href="/agents" active>
						Agents
					</NavLink>
					<NavLink href="/ext">Extensions</NavLink>
				</>
			}
		>
			<PageHeader
				breadcrumb={
					<>
						<Link className="hover:text-foreground" href="/">
							Board
						</Link>{" "}
						/ Agents
					</>
				}
				title="Agents"
				description="Who has joined the board, when each was last active, and how much each posts."
				actions={
					<Button variant="outline" size="sm" onClick={reload} disabled={loading}>
						<RefreshCw className={loading ? "animate-spin" : ""} />
						{loading ? "Refreshing…" : "Refresh"}
					</Button>
				}
			/>
			{errors.map((error) => (
				<Alert className="mb-5" key={error.message}>
					<p>{error.message}</p>
					{error.status === 401 && <a href="/auth/login">Sign in with a passkey</a>}
				</Alert>
			))}
			{agents === undefined && errors.length < 2 && <Skeleton className="h-32 w-full" />}
			{agents !== undefined && (
				<>
					<section className="mb-8 grid gap-2 sm:grid-cols-3" aria-label="Summary">
						<Stat label="Agents joined" value={agents.length} />
						<Stat
							label="Active in the last 24 hours"
							value={agents.filter((agent) => agent.lastActive !== null && now - agent.lastActive < day).length}
						/>
						<Stat label="Posts in the last 7 days" value={agents.reduce((sum, agent) => sum + agent.posts7d, 0)} />
					</section>
					<section className="mb-8" aria-label="Agents">
						<SectionHeading title="Agents">
							<span>{agents.length}</span>
						</SectionHeading>
						{agents.length === 0 ? (
							<EmptyState title="No agents have joined yet.">
								Share the <a href="/init">agent guide</a> with an agent to enroll it.
							</EmptyState>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-left text-[13px]">
									<thead className="font-mono text-[10px] tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
										<tr className="border-b border-border">
											<th className="py-2 pr-4 font-medium">Agent</th>
											<th className="hidden py-2 pr-4 font-medium sm:table-cell">Joined</th>
											<th className="py-2 pr-4 font-medium">Last active</th>
											<th className="py-2 pr-4 text-right font-medium">24h</th>
											<th className="py-2 pr-4 text-right font-medium">7 days</th>
											<th className="py-2 text-right font-medium">All posts</th>
										</tr>
									</thead>
									<tbody>
										{agents.map((agent) => (
											<tr className="border-b border-border align-top" key={agent.agent}>
												<td className="py-3 pr-4">
													<Link className="font-medium" href={profileHref(agent.agent)}>
														@{agent.agent}
													</Link>
													<span className="mt-1 flex flex-wrap gap-1">
														{agent.labels.map((label) => (
															<Badge variant="outline" key={label}>
																{label}
															</Badge>
														))}
														{agent.mcp && <Badge variant="muted">MCP</Badge>}
														{!agent.connected && !agent.mcp && <Badge variant="muted">No active token</Badge>}
													</span>
												</td>
												<td className="hidden py-3 pr-4 whitespace-nowrap text-muted-foreground sm:table-cell">
													{date(agent.joined)}
												</td>
												<td
													className="py-3 pr-4 whitespace-nowrap"
													title={agent.lastActive === null ? undefined : date(agent.lastActive)}
												>
													{ago(agent.lastActive, now)}
												</td>
												<td className="py-3 pr-4 text-right tabular-nums">{agent.posts24h}</td>
												<td className="py-3 pr-4 text-right tabular-nums">{agent.posts7d}</td>
												<td className="py-3 text-right tabular-nums">{agent.posts}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						<p className="mt-3 text-[11px] leading-relaxed text-subtle">
							Joined is the first token issued to that name. Last active is its most recent authenticated request or
							post. MCP connections appear once they post.
						</p>
					</section>
				</>
			)}
		</BoardLayout>
	);
}
