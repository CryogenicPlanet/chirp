import { Effect } from "effect";
import type { Message } from "@comms/protocol/messages";

import type { RequestContext } from "../../kernel/extension-api.ts";

/**
 * Core and third-party views use the same caller-bound automatic mark operation. `mark` advances the topic's read
 * mark through the returned subtree; `seen` records each returned message for `seen_by`, which also suits views whose
 * results are not contiguous, such as mentions, newest and search.
 */
export const markView = (
	ctx: Pick<RequestContext, "topics" | "messages">,
	items: ReadonlyArray<typeof Message.Type>,
	topic: string,
	mark = true,
	seen = mark,
) =>
	Effect.gen(function* () {
		const visible = items.filter((message) => message.topic === topic || message.topic.startsWith(`${topic}/`));
		if (mark && topic !== "" && visible.length)
			yield* ctx.topics.markRead(topic, Math.max(...visible.map((message) => message.seq)));
		const shown = items.filter((message) => message.deleted_at === null).map((message) => message.seq);
		if (seen && shown.length) yield* ctx.messages.markSeen(shown);
	});
