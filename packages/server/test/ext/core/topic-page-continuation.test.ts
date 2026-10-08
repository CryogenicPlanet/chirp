import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { makePageContinuation } from "../../../src/ext/core/topic-page-continuation.ts";

// Root ignores directory permissions, so the image's unlistable parent cannot be reproduced as root.
it.skipIf(process.getuid?.() === 0)(
	"moves topic pages when the pages root's parent is traversable but not listable, as /data is in the image",
	async ({ onTestFinished }) => {
		const data = await mkdtemp(join(tmpdir(), "comms-page-move-"));
		onTestFinished(async () => {
			await chmod(data, 0o755);
			await rm(data, { recursive: true, force: true });
		});
		await mkdir(join(data, "pages", "plans"), { recursive: true });
		await chmod(data, 0o311);
		const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
			Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
		const pages = await run(makePageContinuation(join(data, "pages")));
		// A topic without pages, the common case, must not touch the root's parent at all.
		expect(await run(pages.prepare("notes", "archive/notes", "marker-a"))).toBe(false);
		expect(await run(pages.prepare("plans", "social/plans", "marker-b"))).toBe(true);
		await run(pages.finish({ seq: 1, from_path: "plans", to_path: "social/plans", marker: "marker-b", completed: 0 }));
		await chmod(data, 0o755);
		expect(await readdir(join(data, "pages"))).toEqual(["social"]);
		expect(await readFile(join(data, "pages", "social", "plans", ".comms-move-marker-b"), "utf8")).toBe("marker-b");
	},
);
