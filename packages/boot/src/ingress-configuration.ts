import { Effect, FileSystem, Option, Path, Schema } from "effect";

/** `true` admits every extension's managed routes, `false` none, and a list only those extensions'. */
export type ApplicationManagedIngress = boolean | ReadonlyArray<string>;
export interface IngressConfiguration {
	readonly applicationManagedIngress: ApplicationManagedIngress;
	readonly error: string | null;
}
/** Extension names as the kernel discovers them: a directory such as `mcp` or a file such as `public-pages.ts`. */
const ExtensionName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)));
const Setting = Schema.Union([Schema.Boolean, Schema.Array(ExtensionName)]);
const Configuration = Schema.Struct({ applicationManagedIngress: Setting });

/** The setting as the app receives it in APPLICATION_MANAGED_INGRESS, and as the app must echo it back. */
export const encodeIngress = Schema.encodeSync(Schema.fromJsonString(Setting));
/** What boot writes for a new board: the seed's MCP extension, and nothing else, answers without board credentials. */
const newBoardConfiguration = `${Schema.encodeSync(Schema.fromJsonString(Configuration))({ applicationManagedIngress: ["mcp"] })}\n`;

/** Whether boot forwards anonymous traffic to the live app at all. */
export const ingressEnabled = (ingress: IngressConfiguration) =>
	typeof ingress.applicationManagedIngress === "boolean"
		? ingress.applicationManagedIngress
		: ingress.applicationManagedIngress.length > 0;

/**
 * Writes a new board's explicit setting, only when nothing has that name, and reports whether it did. Boot calls this
 * once, before it records the first seed of the app, so an existing board without a file stays off. The file is owned
 * by boot and mode 0600, so it passes the isolated-mode checks below, and both it and its directory entry are synced
 * before this returns. An interrupted write can leave a short file, which reads as invalid: off, with a diagnostic.
 */
export const seedIngressConfiguration = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.realPath(directory);
		// Exclusive create never replaces an existing name, so an operator's file, or anything else there, always wins.
		const created = yield* Effect.scoped(
			Effect.gen(function* () {
				const file = yield* fs.open(path.join(root, "boot.config.json"), { flag: "wx", mode: 0o600 });
				yield* file.writeAll(new TextEncoder().encode(newBoardConfiguration));
				yield* file.sync;
			}),
		).pipe(Effect.result);
		if (created._tag === "Failure") {
			if (created.failure.reason._tag === "AlreadyExists") return false;
			return yield* created.failure;
		}
		yield* Effect.scoped(Effect.flatMap(fs.open(root), (handle) => handle.sync));
		return true;
	});

/** Operator-owned startup policy. A missing or broken setting means off and never takes recovery or authentication down. */
export const ingressConfiguration = (directory: string, isolated = false) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const filename = path.join(yield* fs.realPath(directory), "boot.config.json");
		const link = yield* fs.readLink(filename).pipe(Effect.result);
		if (link._tag === "Success") return { applicationManagedIngress: false, error: "boot_config_link" };
		const resolved = yield* fs.realPath(filename).pipe(Effect.result);
		if (resolved._tag === "Failure") {
			if (resolved.failure.reason._tag === "NotFound") return { applicationManagedIngress: false, error: null };
			return { applicationManagedIngress: false, error: "boot_config_unreadable" };
		}
		if (resolved.success !== filename) return { applicationManagedIngress: false, error: "boot_config_link" };
		const metadata = yield* fs.stat(filename);
		if (metadata.type !== "File" || metadata.size > 16384n)
			return { applicationManagedIngress: false, error: "boot_config_invalid_file" };
		if (
			isolated &&
			((metadata.mode & 0o022) !== 0 || !Option.exists(metadata.uid, (uid) => uid === 0 || uid === process.getuid?.()))
		)
			return { applicationManagedIngress: false, error: "boot_config_permissions" };
		const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))(
			yield* fs.readFileString(filename),
			{ onExcessProperty: "error" },
		);
		return { applicationManagedIngress: config.applicationManagedIngress, error: null };
	}).pipe(
		Effect.catchCause(() => Effect.succeed({ applicationManagedIngress: false, error: "boot_config_invalid" })),
	) satisfies Effect.Effect<IngressConfiguration, never, FileSystem.FileSystem | Path.Path>;
