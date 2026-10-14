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
export const Envelope = Schema.Struct({
	items: Schema.Array(Message),
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
