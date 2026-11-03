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
/** Without a file, a board serves its MCP extension and nothing else anonymously. */
const defaultIngress: ReadonlyArray<string> = Object.freeze(["mcp"]);

/** The setting as the app receives it in APPLICATION_MANAGED_INGRESS: the same JSON value the operator writes. */
export const encodeIngress = Schema.encodeSync(Schema.fromJsonString(Setting));

/** Whether boot forwards anonymous traffic to the live app at all. */
export const ingressEnabled = (ingress: IngressConfiguration | undefined) =>
	ingress !== undefined &&
	(typeof ingress.applicationManagedIngress === "boolean"
		? ingress.applicationManagedIngress
		: ingress.applicationManagedIngress.length > 0);

/** Operator-owned startup policy. A broken setting never takes recovery or authentication down. */
export const ingressConfiguration = (directory: string, isolated = false) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const filename = path.join(yield* fs.realPath(directory), "boot.config.json");
		const link = yield* fs.readLink(filename).pipe(Effect.result);
		if (link._tag === "Success") return { applicationManagedIngress: false, error: "boot_config_link" };
		const resolved = yield* fs.realPath(filename).pipe(Effect.result);
		if (resolved._tag === "Failure") {
			if (resolved.failure.reason._tag === "NotFound")
				return { applicationManagedIngress: defaultIngress, error: null };
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
