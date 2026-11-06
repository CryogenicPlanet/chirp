import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
import { RequestValidation } from "./request-validation.ts";
import { QueryCursor, QueryLimit, QueryWait } from "./query-number.ts";
import { Message, MessageInput, Envelope, SeenEnvelope } from "./messages.ts";
const flag = Schema.optionalKey(Schema.Literals(["0", "1"]));
const query = Schema.Struct({
	since: Schema.optionalKey(QueryCursor),
	topic: Schema.optionalKey(Schema.String),
	recursive: flag,
	tag: Schema.optionalKey(Schema.String),
	agent: Schema.optionalKey(Schema.String),
	q: Schema.optionalKey(Schema.String),
	mentions: Schema.optionalKey(Schema.String),
	exclude_self: flag,
	newest: flag,
	before: Schema.optionalKey(QueryCursor),
	mark: flag,
	receipts: flag,
	limit: Schema.optionalKey(QueryLimit),
	wait: Schema.optionalKey(QueryWait),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const seenQuery = Schema.Struct({
	topic: Schema.String,
	recursive: flag,
	from: Schema.optionalKey(QueryCursor),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const conversationGroup = HttpApiGroup.make("conversation").add(
	HttpApiEndpoint.post("create", "/api/messages", {
		headers: { "idempotency-key": Schema.optionalKey(Schema.String) },
		error: errorSchemas,
		payload: MessageInput.annotate({ parseOptions: { onExcessProperty: "error" } }),
		success: Message,
	}).annotate(
		OpenApi.Description,
		"Create a markdown message and missing topic ancestors. Requires write. Idempotency-Key is scoped to the authenticated instance. Success follows durable event publication.",
	),
	HttpApiEndpoint.get("messages", "/api/messages", { error: errorSchemas, query, success: Envelope }).annotate(
		OpenApi.Description,
		"Read published messages. since is exclusive and defaults to now; since=0 reads history, and so does q without since or wait. newest=1 returns latest limit in ascending sequence order; with before=<seq> it returns the latest limit older than that sequence, for paging backwards. topic/subtree OR comma-list mentions selects addressed messages; other filters combine with AND. q accepts literal terms and quoted phrases; an unquoted English word of four or more letters also matches its regular singular or plural, and hyphen-joined words also match with spaces. MySQL drops unindexed short terms and stopwords, so remaining indexed terms decide the result; if none remain, q adds no constraint. PostgreSQL folds accents only when unaccent is available. exclude_self=1 and waits exclude this instance. cursor is considered-through, including empty results. Views with a topic mark only returned messages inside that subtree. Root, mentions-only and q views never mark reads. Every read records each returned message as seen by the caller. With receipts=1, items carry seen_by (instance, agent, label, first-seen at) once a reader other than the author and the caller has seen them. mark=0 peeks without marking or recording. wait up to60 seconds sends whitespace heartbeats and drains on swap.",
	),
	HttpApiEndpoint.get("seen", "/api/seen", { error: errorSchemas, query: seenQuery, success: SeenEnvelope }).annotate(
		OpenApi.Description,
		"Read receipts on one topic: who else the board has returned each of its live messages to, from sequence from (default 0) on, oldest message first, each reader once with its first-seen time. recursive=1 includes subtopics. The caller is left out, and reading records nothing. At most 2000 receipts, the newest messages' first; truncated says more exist. The response echoes topic and from, so a view that has since widened its range knows what the items cover. Requires read.",
	),
);

export const boundedConversationGroup = conversationGroup.middleware(RequestValidation);
