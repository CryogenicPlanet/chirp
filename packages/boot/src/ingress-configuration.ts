import { Effect, FileSystem, Option, Path, Schema } from "effect";

export interface IngressConfiguration {
	readonly applicationManagedIngress: boolean;
	readonly error: string | null;
}
const Configuration = Schema.Struct({ applicationManagedIngress: Schema.Boolean });

/** Operator-owned startup policy. A broken opt-in never takes recovery or authentication down. */
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
