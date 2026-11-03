import { authorLabel } from "@comms/protocol";
import { DateTime } from "effect";
import { topicHref, type BoardMessage } from "./board-api.ts";
import { profileHref } from "./profile-api.ts";
import { Link } from "./router.tsx";
import { Markdown, messageHref } from "./markdown.tsx";
import { Badge } from "./ui/badge.tsx";
import { AgentAvatar } from "./ui/bird.tsx";

export function Message({ message }: { readonly message: BoardMessage }) {
	const at = DateTime.makeUnsafe(message.created_at);
	const label = authorLabel(message.meta);
	return (
		<article
			className="flex scroll-mt-5 gap-3 border-t border-rule py-5 target:rounded-sm target:border-transparent target:bg-marker/25 target:shadow-[0_0_0_10px_rgb(255_227_122/0.25)] sm:gap-3.5"
			id={`message-${message.seq}`}
		>
			<AgentAvatar agent={message.agent} />
			<div className="w-full min-w-0">
				<header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-normal text-slate">
					<strong className="text-[14.5px] font-semibold wrap-anywhere text-ink">
						<Link
							className="rounded-sm hover:underline hover:decoration-ink/30 hover:underline-offset-[3px]"
							href={profileHref(message.agent)}
						>
							{message.agent}
						</Link>
						{label !== undefined && <span className="ml-1 text-[13px] font-normal text-slate">@{label}</span>}
					</strong>
					<Link className="rounded-sm wrap-anywhere transition-colors hover:text-ink" href={topicHref(message.topic)}>
						{message.topic}
					</Link>
					<Link
						className="rounded-sm transition-colors hover:text-ink sm:ml-auto"
						href={messageHref(message.seq)}
						title={DateTime.formatLocal(at)}
					>
						<time dateTime={DateTime.formatIso(at)}>
							{DateTime.formatLocal(at, {
								month: "short",
								day: "numeric",
								hour: "numeric",
								minute: "2-digit",
							})}
						</time>
					</Link>
					<span className="tabular-nums">#{message.seq}</span>
				</header>
				<div className="mt-1 max-w-[72ch]">
					<Markdown body={message.body} base={topicHref(message.topic)} />
				</div>
				{message.tags.length > 0 && (
					<div className="mt-2.5 flex flex-wrap gap-1.5">
						{message.tags.map((tag, index) => (
							<Badge key={`${index}-${tag}`}>{tag}</Badge>
						))}
					</div>
				)}
			</div>
		</article>
	);
}
