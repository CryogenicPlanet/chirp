import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, it, type TestContext } from "vitest";
import { conversation } from "../../fixtures/conversation.ts";

const Page = Schema.Struct({ items: Schema.Array(Schema.Struct({ body: Schema.String, instance: Schema.String })) });
const Refused = Schema.Struct({ code: Schema.String });
const Posted = Schema.Struct({ instance: Schema.String });

/**
 * A board with a probe extension: one managed route posts as a named instance, another runs a raw message query, so
 * the query options extensions get (but core's HTTP route does not expose) are exercised against real SQL.
 */
const board = async (test: TestContext) => {
	const fixture = await conversation(test);
	const seed = join(fixture.root, "seed");
	await cp(join(import.meta.dirname, "../../../src"), seed, { recursive: true });
	await writeFile(
		join(seed, "ext/probe.ts"),
		`import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";
export default (api: Api) => {
 api.route("POST", "/probe/post", {description: "Post as a named instance", access: "application-managed", handler: (_request, ctx) =>
  ctx.messages.create({topic: String(ctx.query.topic), body: String(ctx.query.body)}, undefined, {agent: "probe", instance: String(ctx.query.instance)}).pipe(Effect.map((message) => Response.json(message)))});
 api.route("GET", "/probe/query", {description: "Run a message query", access: "application-managed", handler: (_request, ctx) =>
  ctx.messages.query(JSON.parse(String(ctx.query.input))).pipe(
   Effect.map((page) => Response.json({items: page.items.map((item) => ({body: item.body, instance: item.instance}))})),
   Effect.catchTag("KernelError", (error) => Effect.succeed(Response.json({code: error.code}))))});
};`,
	);
	await writeFile(join(fixture.root, "boot.config.json"), JSON.stringify({ applicationManagedIngress: true }));
	const app = await fixture.launch(join(seed, "server.ts"));
	await app.setup();
	await app.ready(await app.login());
	/** Posts as `extension:<file>:<instance>` and returns that composed instance. */
	const post = async (topic: string, body: string, instance: string) => {
		const response = await fetch(`${app.url}/probe/post?${new URLSearchParams({ topic, body, instance })}`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		return Schema.decodeUnknownSync(Posted)(await response.json()).instance;
	};
	const query = async (input: Readonly<Record<string, unknown>>): Promise<unknown> =>
		(
			await fetch(
				`${app.url}/probe/query?${new URLSearchParams({ input: JSON.stringify({ since: 0, limit: 50, ...input }) })}`,
			)
		).json();
	const bodies = async (input: Readonly<Record<string, unknown>>) =>
		Schema.decodeUnknownSync(Page)(await query(input)).items.map((item) => item.body);
	return { post, query, bodies };
};

it("ANDs topic and mentions only when all is set and both are given", async (test) => {
	const { post, bodies } = await board(test);
	await post("alpha", "@x in alpha", "one");
	await post("alpha", "plain in alpha", "one");
	await post("alpha/sub", "@x in a subtopic", "one");
	await post("beta", "@x in beta", "one");
	// Without all, topic and mentions widen each other.
	expect(await bodies({ topic: "alpha", recursive: true, mentions: ["@x"] })).toEqual([
		"@x in alpha",
		"plain in alpha",
		"@x in a subtopic",
		"@x in beta",
	]);
	expect(await bodies({ topic: "alpha", recursive: true, mentions: ["@x"], all: true })).toEqual([
		"@x in alpha",
		"@x in a subtopic",
	]);
	expect(await bodies({ topic: "alpha", mentions: ["@x"], all: true })).toEqual(["@x in alpha"]);
	// With only one of the two, all changes nothing.
	expect(await bodies({ topic: "alpha", all: true })).toEqual(["@x in alpha", "plain in alpha"]);
	expect(await bodies({ mentions: ["@x"], all: true })).toEqual(["@x in alpha", "@x in a subtopic", "@x in beta"]);
}, 60000);

it("omits the posts of every excluded instance before the page is limited", async (test) => {
	const { post, bodies } = await board(test);
	const one = await post("gamma", "from one", "one");
	const two = await post("gamma", "from two", "two");
	const three = await post("gamma", "from three", "three");
	await post("gamma", "from one again", "one");
	expect(await bodies({ topic: "gamma", exclude: one })).toEqual(["from two", "from three"]);
	expect(await bodies({ topic: "gamma", exclude: [one, three] })).toEqual(["from two"]);
	// The exclusion applies before the limit, so a page of one still finds the post nobody excluded.
	expect(await bodies({ topic: "gamma", exclude: [one, two], limit: 1 })).toEqual(["from three"]);
	expect(await bodies({ topic: "gamma", exclude: [] })).toHaveLength(4);
}, 60000);

it("refuses queries past their limits", async (test) => {
	const { post, query, bodies } = await board(test);
	const kept = await post("delta", "kept", "kept");
	const many = (count: number) => Array.from({ length: count }, (_, index) => `${kept}-other-${index}`);
	expect(await bodies({ topic: "delta", exclude: many(64) })).toEqual(["kept"]);
	for (const input of [
		{ exclude: many(65) },
		{ mentions: Array.from({ length: 33 }, (_, index) => `@agent${index}`) },
		{ limit: 201 },
		{ limit: 0 },
	])
		expect(Schema.decodeUnknownSync(Refused)(await query(input)), JSON.stringify(input).slice(0, 80)).toEqual({
			code: "query_invalid",
		});
}, 60000);
