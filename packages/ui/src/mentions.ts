/**
 * The server's mention grammar (packages/server/src/ext/core/message-mentions.ts): the whole @path is consumed,
 * then trailing punctuation is trimmed. Kept in one place for rendering, the composer and autocomplete.
 */
export const mentionPattern = /(?<![\p{L}\p{N}\p{M}@/:])@[a-z0-9][a-z0-9._/-]*(?![\p{L}\p{N}\p{M}@/._-])/u;
const mentionTarget = /^@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

/** The mention a raw `@…` match names, or null when the server would not record it. */
export const mentionOf = (raw: string): string | null => {
	const target = raw.replace(/[._-]+$/u, "");
	return target.length <= 200 && mentionTarget.test(target) ? target : null;
};

export const mentionsIn = (body: string): ReadonlyArray<string> => [
	...new Set(
		[...body.matchAll(new RegExp(mentionPattern.source, "gu"))]
			.map((match) => mentionOf(match[0]))
			.filter((target) => target !== null),
	),
];

/**
 * Everyone a message can reach: agent names and their labels, @here, and any custom names (like @all or
 * @channel) a board declares through an extension's `GET /api/mentions`.
 */
export interface Directory {
	readonly agents: ReadonlyArray<{ readonly name: string; readonly labels: ReadonlyArray<string> }>;
	readonly custom: ReadonlyArray<{ readonly mention: string; readonly description: string }>;
}

export const emptyDirectory: Directory = { agents: [], custom: [] };

export interface MentionOption {
	readonly mention: string;
	readonly name: string;
	readonly hint: string;
}

/** @here reaches every listening agent; @name every instance of it; @name/label one instance. */
export const mentionOptions = (directory: Directory): ReadonlyArray<MentionOption> => [
	{ mention: "@here", name: "here", hint: "Every listening agent" },
	...directory.custom.map((item) => ({ mention: item.mention, name: "here", hint: item.description || "Custom" })),
	...directory.agents.flatMap((agent) => [
		{
			mention: `@${agent.name}`,
			name: agent.name,
			hint: agent.labels.length > 1 ? `All ${agent.labels.length} instances` : "Agent",
		},
		...(agent.labels.length > 1
			? agent.labels.map((label) => ({ mention: `@${agent.name}/${label}`, name: agent.name, hint: "One instance" }))
			: []),
	]),
];

/** A mention is known when it names @here, a custom name, a known agent, or one of its labels. */
export const reachable = (directory: Directory, mention: string): boolean => {
	if (directory.custom.some((item) => item.mention === mention)) return true;
	const [name, label, ...rest] = mention.slice(1).split("/");
	if (rest.length > 0 || name === undefined) return false;
	if (name === "here") return label === undefined;
	const agent = directory.agents.find((item) => item.name === name);
	return agent !== undefined && (label === undefined || agent.labels.includes(label));
};
