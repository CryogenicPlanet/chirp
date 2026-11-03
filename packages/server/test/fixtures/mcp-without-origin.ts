import { BunServices } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Layer } from "effect";
import mcp from "../../src/ext/mcp/index.ts";
import type { Api } from "../../src/kernel/extension-api.ts";
import { work } from "../../src/kernel/extension-work.ts";

/** Loads the MCP factory as a boot that names no board origin would, printing what it registered. */
const registered: string[] = [];
const unused = () => Effect.die("MCP must not touch the board without an origin");
const api: Api = {
	origin: undefined,
	effects: { fetch: unused, notify: unused, timer: unused, recordCron: unused, report: unused() },
	context: unused,
	migrate: unused,
	mount: () => registered.push("mount"),
	page: (path) => registered.push(path),
	cron: (expression) => registered.push(expression),
	route: (method, path) => registered.push(`${method} ${path}`),
	on: (...args) => registered.push(String(args[0])),
};
await Effect.runPromise(
	Effect.scoped(work(() => mcp(api))).pipe(
		Effect.provide(Layer.merge(BunServices.layer, SqliteClient.layer({ filename: ":memory:" }))),
	),
);
process.stdout.write(`MCP_WITHOUT_ORIGIN_REGISTERED=${JSON.stringify(registered)}\n`);
