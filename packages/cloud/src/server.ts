import { createServer } from "node:http";
import { Config, Effect } from "effect";
import next from "next";
import { disposeAuthRequestRuntime } from "./auth-runtime.ts";
import { isIpv4BindAddress, isProxyTransport } from "./client-ip-boundary.ts";
import { databaseLayer } from "./database.ts";
import { migrateCloudDatabase } from "./migrations.ts";
import { startWorkerRuntime } from "./worker-runtime.ts";

const { hostname, port } = await Effect.runPromise(
	Config.all({
		hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
		port: Config.Port("PORT").pipe(Config.withDefault(3000)),
	}),
);
if (!isIpv4BindAddress(hostname)) throw new Error("HOST must be an IPv4 address");
await Effect.runPromise(
	migrateCloudDatabase.pipe(
		Effect.provide(databaseLayer),
		Effect.tapError((error) =>
			Effect.logError(
				"Chirp Cloud schema preparation failed; refusing startup",
				error._tag === "CloudMigrationError" ? error.message : error._tag,
			),
		),
	),
);
const app = next({ dev: false, hostname, port });
const workerRuntime = await startWorkerRuntime();
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((request, response) => {
	if (!isProxyTransport(request.socket.remoteAddress)) {
		response.writeHead(403);
		response.end("Forbidden");
		return;
	}
	void handler(request, response).catch(() => {
		if (!response.headersSent) response.writeHead(500);
		response.end("Internal Server Error");
	});
});

await Effect.runPromise(
	Effect.callback<void>((resume) => {
		const failed = (cause: unknown) => resume(Effect.die(cause));
		server.once("error", failed);
		server.listen(port, hostname, () => {
			server.removeListener("error", failed);
			resume(Effect.void);
		});
	}),
);
process.stdout.write(`Chirp Cloud listening on ${hostname}:${port}\n`);

let closing = false;
const shutdown = (signal: "SIGINT" | "SIGTERM") => {
	if (closing) return;
	closing = true;
	Effect.gen(function* () {
		yield* Effect.callback<void>((resume) => {
			server.close((error) => resume(error ? Effect.die(error) : Effect.void));
			server.closeIdleConnections();
		});
		yield* Effect.promise(() => app.close());
		yield* Effect.promise(() => workerRuntime.dispose());
		yield* Effect.promise(disposeAuthRequestRuntime);
		process.stdout.write("Chirp Cloud stopped cleanly\n");
		process.exitCode = signal === "SIGINT" ? 130 : 143;
	}).pipe(
		Effect.catchCause(() => Effect.sync(() => (process.exitCode = 1))),
		Effect.runFork,
	);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
