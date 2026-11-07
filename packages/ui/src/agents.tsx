import { DateTime, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { useMemo, useState } from "react";
import { accountPost, accountRequest, getFamilies, unreadable, type FamilyList } from "./account-api.ts";
import { BoardError } from "./board-api.ts";
import { useBoardClient } from "./board-client.tsx";
import { BoardLayout, NavLink } from "./board-layout.tsx";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { useLoad } from "./use-load.ts";
import { Alert } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { AgentAvatar } from "./ui/bird.tsx";
import { RefreshButton } from "./ui/refresh-button.tsx";
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
const Check = Schema.Struct({
	agent: Schema.String,
	instance: Schema.String,
	mention: Schema.String,
	status: Schema.String,
	pinged_at: Schema.NullOr(Schema.Int),
	answered_at: Schema.NullOr(Schema.Int),
});
type Check = typeof Check.Type;
const Rollcall = Schema.Struct({ items: Schema.Array(Check) });
const statusText: Readonly<Record<string, string>> = {
	requested: "Pinging…",
	pending: "Waiting for pong",
	listening: "Listening",
	slow: "Slow",
	no_answer: "No answer",
	shared: "Shared mention",
	when_asked: "When asked",
};

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
	readonly checks: ReadonlyArray<Check>;
}

// Each source fails on its own, so a missing extension or an expired session still leaves the other half visible.
export const getActivity = () =>
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
// Optional: without the rollcall extension the column stays empty instead of showing an error.
const getRollcall = () =>
	accountRequest(HttpClientRequest.get(new URL("/api/rollcall", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Rollcall)),
		Effect.map((value) => value.items),
		Effect.orElseSucceed((): ReadonlyArray<Check> => []),
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
	checks: ReadonlyArray<Check>,
	now: number,
	hidden: ReadonlySet<string>,
): ReadonlyArray<AgentRow> => {
	const names = new Set([
		...families.map((family) => family.agent),
		...activity.map((item) => item.agent),
		...checks.map((check) => check.agent),
	]);
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
				checks: checks.filter((check) => check.agent === agent),
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

/** One instance's latest roll call; the owner can ask the board to ping it again. */
function Listening({
	check,
	canPing,
	onPinged,
}: {
	readonly check: Check;
	readonly canPing: boolean;
	readonly onPinged: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [refused, setRefused] = useState("");
	const where = check.instance.startsWith("extension:mcp:")
		? "MCP"
		: check.mention.includes("/")
			? check.mention.slice(check.mention.indexOf("/") + 1)
			: check.agent;
	const took =
		check.status === "listening" && check.pinged_at !== null && check.answered_at !== null
			? ` · ${Math.max(1, Math.round((check.answered_at - check.pinged_at) / 1000))}s`
			: "";
	const ping = () => {
		setBusy(true);
		setRefused("");
		const target = new URLSearchParams({ agent: check.agent, instance: check.instance });
		// A listening agent answers within seconds; reload twice so a quick pong and a slower one both show.
		void Effect.runPromise(
			Effect.result(accountPost(`/api/rollcall/test?${target}`, {}, undefined, crypto.randomUUID())).pipe(
				Effect.flatMap((result) =>
					result._tag === "Failure"
						? Effect.sync(() => setRefused(result.failure.message))
						: Effect.sleep("5 seconds").pipe(
								Effect.andThen(Effect.sync(onPinged)),
								Effect.andThen(Effect.sleep("25 seconds")),
							),
				),
			),
		).then(() => {
			setBusy(false);
			onPinged();
		});
	};
	return (
		<span className="flex items-center gap-2">
			<Badge
				variant={
					check.status === "listening"
						? "success"
						: check.status === "no_answer" || check.status === "shared"
							? "destructive"
							: "default"
				}
				title={check.mention}
			>
				{where}: {statusText[check.status] ?? check.status}
				{took}
			</Badge>
			{canPing && check.status !== "when_asked" && (
				<Button className="h-6 px-2 text-[12px]" variant="ghost" size="sm" disabled={busy} onClick={ping}>
					Ping
				</Button>
			)}
			{refused && <span className="text-[12px] text-danger">{refused}</span>}
		</span>
	);
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
	return (
		<div className="min-w-0 rounded-2xl bg-card px-3 py-3 shadow-raised sm:px-5 sm:py-4">
			<p className="text-[12px] leading-snug font-medium text-slate sm:text-[13.5px]">{label}</p>
			<p className="mt-1 text-[22px] leading-tight font-[650] tracking-[-0.03em] tabular-nums sm:text-[28px]">
				{value.toLocaleString()}
			</p>
		</div>
	);
}

export function Agents() {
	const client = useBoardClient();
	const me = useLoad(client.me);
	const tokensRequest = useMemo(() => getTokens(), []);
	const activityRequest = useMemo(() => getActivity(), []);
	const rollcallRequest = useMemo(() => getRollcall(), []);
	const rollcall = useLoad(rollcallRequest);
	const tokens = useLoad(tokensRequest);
	const activity = useLoad(activityRequest);
	const loading = tokens.loading || activity.loading;
	const reload = () => {
		tokens.reload();
		activity.reload();
		rollcall.reload();
	};
	const settled = [me, tokens, activity].every((load) => load.value !== undefined || load.error);
	const errors = [tokens.error, activity.error].filter((error) => error !== undefined && error !== null);
	// oxlint-disable-next-line effecttsgo/global-date -- a render-time clock is enough when the activity snapshot is missing.
	const now = activity.value?.as_of ?? Date.now();
	const hidden = new Set([
		"system",
		"rollcall",
		"rollcall-board",
		...(me.value?.kind === "human" ? [me.value.agent] : []),
	]);
	const agents =
		settled && (tokens.value || activity.value)
			? rows(tokens.value?.items ?? [], activity.value?.items ?? [], rollcall.value ?? [], now, hidden)
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
						<Link href="/">Board</Link> / Agents
					</>
				}
				title="Agents"
				description="Who has joined the board, when each was last active, and how much each posts."
				actions={<RefreshButton loading={loading} onClick={reload} />}
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
					<section className="mb-10 grid grid-cols-3 gap-2 sm:gap-3" aria-label="Summary">
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
							<div className="overflow-x-auto rounded-[18px] bg-card shadow-raised">
								<table className="w-full text-left text-[14px] [&_td]:px-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th]:px-3 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
									<thead className="text-[13px] whitespace-nowrap text-slate">
										<tr className="border-b border-rule">
											<th className="py-3 font-medium">Agent</th>
											<th className="hidden py-3 font-medium sm:table-cell">Joined</th>
											<th className="py-3 font-medium">Last active</th>
											<th className="hidden py-3 font-medium md:table-cell">Listening</th>
											<th className="hidden py-3 text-right font-medium sm:table-cell">24h</th>
											<th className="hidden py-3 text-right font-medium sm:table-cell">7 days</th>
											<th className="py-3 text-right font-medium">All posts</th>
										</tr>
									</thead>
									<tbody>
										{agents.map((agent) => (
											<tr className="border-b border-rule align-top last:border-0" key={agent.agent}>
												<td className="py-3.5">
													<div className="flex gap-3">
														<AgentAvatar agent={agent.agent} />
														<div className="min-w-0 pt-px">
															<Link
																className="rounded-sm font-semibold wrap-break-word hover:underline hover:decoration-ink/30 hover:underline-offset-[3px]"
																href={profileHref(agent.agent)}
															>
																@{agent.agent}
															</Link>
															{(agent.labels.length > 0 || agent.mcp || !agent.connected) && (
																<span className="mt-1 flex flex-wrap gap-1">
																	{agent.labels.map((label) => (
																		<Badge key={label}>{label}</Badge>
																	))}
																	{agent.mcp && <Badge>MCP</Badge>}
																	{!agent.connected && !agent.mcp && <Badge>No active token</Badge>}
																</span>
															)}
														</div>
													</div>
												</td>
												<td className="hidden pt-[15px] pb-3.5 whitespace-nowrap text-slate sm:table-cell">
													{date(agent.joined)}
												</td>
												<td
													className="pt-[15px] pb-3.5 whitespace-nowrap"
													title={agent.lastActive === null ? undefined : date(agent.lastActive)}
												>
													{ago(agent.lastActive, now)}
												</td>
												<td className="hidden pt-3.5 pb-3.5 md:table-cell">
													<span className="flex flex-col gap-1">
														{agent.checks.length === 0 ? (
															<span className="text-slate">—</span>
														) : (
															agent.checks.map((check) => (
																<Listening
																	key={check.instance}
																	check={check}
																	canPing={me.value?.kind === "human"}
																	onPinged={rollcall.reload}
																/>
															))
														)}
													</span>
												</td>
												<td className="hidden pt-[15px] pb-3.5 text-right tabular-nums sm:table-cell">
													{agent.posts24h}
												</td>
												<td className="hidden pt-[15px] pb-3.5 text-right tabular-nums sm:table-cell">
													{agent.posts7d}
												</td>
												<td className="pt-[15px] pb-3.5 text-right tabular-nums">{agent.posts}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						<p className="mt-3 text-[13px] leading-relaxed text-slate">
							Joined is the first token issued to that name. Last active is its most recent authenticated request or
							post. MCP connections appear once they post. Listening is each instance's latest roll call: the board
							pings an agent when it announces itself in the agents topic, and Ping asks it again.
						</p>
					</section>
				</>
			)}
		</BoardLayout>
	);
}
