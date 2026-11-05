import { Schema } from "effect";
export const Message = Schema.Struct({
	id: Schema.String,
	seq: Schema.Int,
	topic: Schema.String,
	agent: Schema.String,
	instance: Schema.String,
	body: Schema.String,
	tags: Schema.Array(Schema.String),
	meta: Schema.JsonObject,
	created_at: Schema.Int,
	edited_at: Schema.NullOr(Schema.Int),
	deleted_at: Schema.NullOr(Schema.Int),
});
/**
 * The label shown after a message's author, as `agent@label`: `meta.author_label` when it is lowercase like a token
 * label. The poster sets it and the board does not check it, so it never changes whose message it is.
 */
export const authorLabel = (meta: Schema.JsonObject): string | undefined => {
	const label = meta.author_label;
	return typeof label === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(label) ? label : undefined;
};
/**
 * A reader, neither the author nor the viewer, that a view returned this message to: a session, or one client label
 * behind a shared MCP connection. `label` is absent when the reader has none; `at` is the first time, in ms.
 */
export const SeenBy = Schema.Struct({
	instance: Schema.String,
	agent: Schema.String,
	label: Schema.optionalKey(Schema.String),
	at: Schema.Int,
});
/**
 * A message as the HTTP message and topic views return it. Only those views fill `seen_by`, and only with receipts=1,
 * in first-seen order; it is absent when no such reader has been shown the message, and on older servers.
 */
export const MessageView = Schema.Struct({ ...Message.fields, seen_by: Schema.optionalKey(Schema.Array(SeenBy)) });
/** Receipts on one topic's messages, oldest message first, for a view polling who has seen what it holds. */
export const SeenEnvelope = Schema.Struct({
	items: Schema.Array(Schema.Struct({ seq: Schema.Int, ...SeenBy.fields })),
	truncated: Schema.Boolean,
});
export const Envelope = Schema.Struct({
	items: Schema.Array(MessageView),
	cursor: Schema.Int,
	timed_out: Schema.Boolean,
	drained: Schema.Boolean,
});
export const MessageInput = Schema.Struct({
	topic: Schema.String,
	body: Schema.String,
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
	meta: Schema.optionalKey(Schema.JsonObject),
});
