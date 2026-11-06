import { expect, it } from "vitest";
import type { BoardMessage } from "../src/board-api.ts";
import { mentionedAgents, readPositions, seenAt, seenByMessage } from "../src/receipts.ts";

const message = (seq: number, agent: string, body = ""): BoardMessage => ({
	id: `m${seq}`,
	seq,
	topic: "work",
	agent,
	instance: `i-${agent}`,
	body,
	tags: [],
	meta: {},
	created_at: seq,
	edited_at: null,
	deleted_at: null,
});

it("groups readers by agent, leaving out the viewer and the board's own names", () => {
	const seen = seenByMessage(
		[
			{ seq: 1, instance: "a", agent: "dot", label: "codex", at: 30 },
			{ seq: 1, instance: "a", agent: "dot", label: "chatgpt", at: 10 },
			{ seq: 1, instance: "r", agent: "rahul", label: "human", at: 5 },
			{ seq: 1, instance: "s", agent: "system", at: 1 },
		],
		"rahul",
	);
	expect(seen.get(1)).toEqual([
		{
			agent: "dot",
			at: 10,
			readers: [
				{ label: "chatgpt", at: 10 },
				{ label: "codex", at: 30 },
			],
		},
	]);
});

it("places each agent under the newest message it has seen, unless it posted after that", () => {
	const messages = [message(1, "claude"), message(2, "codex"), message(3, "claude"), message(4, "system")];
	const seen = seenByMessage(
		[
			{ seq: 1, instance: "c", agent: "codex", at: 1 },
			{ seq: 1, instance: "h", agent: "hermes", at: 1 },
			{ seq: 3, instance: "m", agent: "muse", at: 1 },
			{ seq: 4, instance: "h", agent: "hermes", at: 2 },
		],
		null,
	);
	const positions = readPositions(messages, seen);
	// codex read #1 then posted #2, so its own post marks its place; hermes's system read is not a place to sit.
	expect([...positions].map(([seq, entries]) => [seq, entries.map((entry) => entry.agent)])).toEqual([
		[1, ["hermes"]],
		[3, ["muse"]],
	]);
});

it("tracks only agents named directly, and one instance when the mention names it", () => {
	const directory = {
		agents: [
			{ name: "codex", labels: ["job-17", "mac"] },
			{ name: "rahul", labels: ["human"] },
		],
		custom: [{ mention: "@all", description: "" }],
		self: "rahul",
	};
	const targets = mentionedAgents("@codex/mac and @codex, @codex/mac/other, @all, @here, @rahul and @ghost", directory);
	expect(targets).toEqual([
		{ agent: "codex", label: "mac" },
		{ agent: "codex", label: undefined },
	]);
	const seen = [{ agent: "codex", at: 5, readers: [{ label: "job-17", at: 5 }] }];
	expect(seenAt(seen, { agent: "codex", label: undefined })).toBe(5);
	expect(seenAt(seen, { agent: "codex", label: "mac" })).toBeUndefined();
});
