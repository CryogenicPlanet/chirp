import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";

// The editable app has its own dependency boundary; launchers stay in the image.
Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const server = yield* path.fromFileUrl(new URL(".", import.meta.url));
	const target = path.join(server, "dist", "runtime-seed");
	const pages = path.join(server, "dist", "pages-seed");
	yield* fs.remove(target, { recursive: true, force: true });
	yield* fs.remove(pages, { recursive: true, force: true });
	yield* fs.copy(path.join(server, "src"), target);
	yield* fs.copy(path.join(server, "pages"), pages);
	yield* fs.copy(path.resolve(server, "../../examples/extensions/mcp"), path.join(pages, "tooling", "mcp"));
	for (const launcher of ["main.ts", "start.ts"]) yield* fs.remove(path.join(target, launcher));
	for (const file of ["package.json", "bun.lock"])
		yield* fs.copyFile(path.join(server, "runtime", file), path.join(target, file));
	for (const workspace of ["protocol", "storage"]) {
		const source = path.resolve(server, `../${workspace}`);
		yield* fs.makeDirectory(path.join(target, workspace));
		for (const file of ["src", "docs", "package.json"])
			yield* fs.copy(path.join(source, file), path.join(target, workspace, file));
	}
	// The standalone installer must apply the same remote pool-ownership fix.
	yield* fs.makeDirectory(path.join(target, "patches"));
	for (const patch of [
		"@effect%2Fsql-mysql2@4.0.0-rc.113.patch",
		"@effect%2Fsql-pg@4.0.0-rc.113.patch",
		"effect@4.0.0-rc.113.patch",
	]) {
		yield* fs.copyFile(path.resolve(server, "../../patches", patch), path.join(target, "patches", patch));
	}
	const ui = path.resolve(server, "../ui");
	yield* fs.makeDirectory(path.join(target, "ui"));
	for (const file of ["src", "public", "index.html", "vite.config.ts"])
		yield* fs.copy(path.join(ui, file), path.join(target, "ui", file));
}).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
