import { BunHttpServer, BunSocket } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Path, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Auth } from "./auth.ts";

/** Only the OS operator can reach this listener. It is never mounted on the public router. */
export const setupCodeServer = Effect.fn("setupCodeServer")(function* (dataDirectory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const auth = yield* Auth;
	const root = yield* fs.realPath(dataDirectory);
	const directory = path.join(root, ".boot-operator");
	yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
	const info = yield* fs.stat(directory);
	if (
		(yield* fs.realPath(directory)) !== directory ||
		info.type !== "Directory" ||
		!Option.contains(info.uid, process.getuid?.()) ||
		(info.mode & 0o777) !== 0o700
	)
		return yield* Effect.die("Invalid boot operator directory");
	const socket = path.join(directory, "setup.sock");
	if (yield* fs.exists(socket)) {
		// realpath on a disconnected Unix socket is unsupported by Bun/macOS. readlink
		// distinguishes a direct socket from a symlink without following it.
		const direct = yield* fs.readLink(socket).pipe(
			Effect.as(false),
			Effect.catch((error) =>
				error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL"
					? Effect.succeed(true)
					: Effect.fail(error),
			),
		);
		if ((yield* fs.stat(socket)).type !== "Socket" || !direct) return yield* Effect.die("Invalid boot operator socket");
		// Only a refused connection proves a stale socket. Never replace a running listener.
		const stale = yield* BunSocket.makeNet({ path: socket, openTimeout: "1 second" }).pipe(
			Effect.flatMap((connection) => connection.reader),
			Effect.as(false),
			Effect.scoped,
			Effect.catch((error) => {
				const cause = error.reason.cause;
				return Effect.succeed(cause instanceof Error && "code" in cause && cause.code === "ECONNREFUSED");
			}),
		);
		if (!stale) return yield* Effect.die("Boot operator socket already active or inaccessible");
		yield* fs.remove(socket);
	}
	// Register removal before the server so the listener closes before its pathname disappears.
	const owned = yield* Ref.make<FileSystem.File.Info | null>(null);
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			const original = yield* Ref.get(owned);
			if (!original || !(yield* fs.exists(socket))) return;
			const current = yield* fs.stat(socket);
			if (
				current.type === "Socket" &&
				current.dev === original.dev &&
				Option.isSome(original.ino) &&
				Option.contains(current.ino, original.ino.value)
			)
				yield* fs.remove(socket);
		}).pipe(Effect.orDie),
	);
	const server = yield* BunHttpServer.make({
		unix: socket,
		maxRequestBodySize: 0,
		gracefulShutdownTimeout: "1 second",
	});
	yield* Ref.set(owned, yield* fs.stat(socket));
	yield* fs.chmod(socket, 0o600);
	yield* server.serve(
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (request.method !== "POST" || request.url !== "/setup-code") return HttpServerResponse.empty({ status: 404 });
			return yield* auth.mintSetupCode.pipe(
				Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { headers: { "cache-control": "no-store" } })),
				Effect.catchTag("AuthError", () =>
					Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "setup_closed" }, { status: 409 })),
				),
				Effect.catch(() =>
					Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "setup_code_unavailable" }, { status: 503 })),
				),
			);
		}),
	);
});
