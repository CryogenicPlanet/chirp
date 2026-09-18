import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type TestContext } from "vitest";
import { conversation } from "./conversation.ts";

/** Hold a real candidate after health while boot's mutation gate remains frozen. */
export async function ingressCutover(test: TestContext) {
	const fixture = await conversation(test);
	const boot = join(fixture.root, "packages/boot");
	await cp(join(import.meta.dirname, "../../../boot/src"), join(boot, "src"), { recursive: true });
	await mkdir(join(boot, "test/fixtures"), { recursive: true });
	await cp(
		join(import.meta.dirname, "../../../boot/test/fixtures/launcher.ts"),
		join(boot, "test/fixtures/launcher.ts"),
	);
	await symlink(join(import.meta.dirname, "../../../boot/node_modules"), join(boot, "node_modules"));
	const server = join(fixture.root, "packages/server/src");
	await cp(join(import.meta.dirname, "../../src"), server, { recursive: true });
	await symlink(join(import.meta.dirname, "../../node_modules"), join(server, "../node_modules"));
	await writeFile(join(fixture.root, "boot.config.json"), '{"applicationManagedIngress":true}', { mode: 0o600 });
	const extension = `import { Effect } from "effect";
export default api => api.route("POST", "/managed-cutover", {
 description:"Controlled ingress cutover writer",access:"application-managed",
 handler:(request,ctx)=>Effect.gen(function*(){
  const body = yield* request.text;
  return Response.json(yield* ctx.messages.create({topic:"ingress-cutover",body},request.headers["idempotency-key"]));
 })
});`;
	await writeFile(join(server, "ext/managed-cutover.ts"), extension);
	const marker = join(fixture.root, "ingress-candidate-ready");
	const release = join(fixture.root, "ingress-candidate-release");
	const cutoverPath = join(boot, "src/cutover.ts");
	const cutover = await readFile(cutoverPath, "utf8");
	const health = '}).pipe(Effect.timeout("5 seconds"));';
	expect(cutover.split(health)).toHaveLength(2);
	await writeFile(
		cutoverPath,
		cutover.replace(
			health,
			health +
				`
 yield* fs.writeFileString(${JSON.stringify(marker)},String(candidate.process.pid));
 while (!(yield* fs.exists(${JSON.stringify(release)}))) yield* Effect.sleep("10 millis");
 `,
		),
	);
	return {
		...fixture,
		extension,
		launch: () => fixture.launch(join(server, "server.ts"), join(boot, "test/fixtures/launcher.ts")),
		wait: async () => {
			await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 20000 }).not.toBe("");
			return Number(await readFile(marker, "utf8"));
		},
		release: () => writeFile(release, "release"),
	};
}
