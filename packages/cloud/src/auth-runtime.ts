import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CloudAuthSettings } from "./auth-settings.ts";
import { cloudAuthSettings } from "./auth-settings.ts";
import { CloudAuth, cloudAuthLayer } from "./cloud-auth.ts";

export interface AuthRequestRuntime {
	readonly handle: (request: Request) => Promise<Response>;
	readonly dispose: () => Promise<void>;
}

export const makeAuthRequestRuntime = <E>(settings: Effect.Effect<CloudAuthSettings, E>): AuthRequestRuntime => {
	const runtime = ManagedRuntime.make(
		Layer.unwrap(settings.pipe(Effect.map(cloudAuthLayer))).pipe(Layer.provideMerge(NodeServices.layer)),
	);
	return {
		handle: (request: Request) =>
			runtime
				.runPromise(CloudAuth.use((auth) => auth.handle(request)))
				.catch(() => Response.json({ error: "authentication_unavailable" }, { status: 503 })),
		dispose: () => runtime.dispose(),
	};
};

declare global {
	var chirpCloudAuthRuntime: AuthRequestRuntime | undefined;
}

const live = (globalThis.chirpCloudAuthRuntime ??= makeAuthRequestRuntime(cloudAuthSettings));

export const handleAuthRequest = live.handle;
export const disposeAuthRequestRuntime = live.dispose;
