import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CloudAuthSettings } from "./auth-settings.ts";
import { cloudAuthSettings } from "./auth-settings.ts";
import { CloudAuth, cloudAuthLayer } from "./cloud-auth.ts";
import { makeDashboardRequestRuntime } from "./dashboard-runtime.ts";

export interface AuthRequestRuntime {
	readonly dashboard: ReturnType<typeof makeDashboardRequestRuntime>;
	readonly getPublicOrigin: () => Promise<string>;
	readonly handle: (request: Request) => Promise<Response>;
	readonly getSession: (headers: Headers) => Promise<AuthSession | null>;
	readonly getSessionWithHeaders: (headers: Headers) => Promise<{
		readonly session: AuthSession | null;
		readonly headers: Headers;
	}>;
	readonly dispose: () => Promise<void>;
}

interface AuthSession {
	readonly user: { readonly id: string; readonly name: string; readonly email: string };
}

const projectSession = (session: { readonly user: AuthSession["user"] } | null): AuthSession | null =>
	session ? { user: { id: session.user.id, name: session.user.name, email: session.user.email } } : null;

export const makeAuthRequestRuntime = <E>(settings: Effect.Effect<CloudAuthSettings, E>): AuthRequestRuntime => {
	const dashboard = makeDashboardRequestRuntime();
	const runtime = ManagedRuntime.make(
		Layer.unwrap(settings.pipe(Effect.map(cloudAuthLayer))).pipe(Layer.provideMerge(NodeServices.layer)),
	);
	return {
		dashboard,
		getPublicOrigin: () => runtime.runPromise(CloudAuth.use((auth) => Effect.succeed(auth.publicOrigin))),
		handle: (request: Request) =>
			runtime
				.runPromise(CloudAuth.use((auth) => auth.handle(request)))
				.catch(() => Response.json({ error: "authentication_unavailable" }, { status: 503 })),
		getSession: (headers: Headers) =>
			runtime.runPromise(CloudAuth.use((auth) => auth.getSession(headers)).pipe(Effect.map(projectSession))),
		getSessionWithHeaders: (headers: Headers) =>
			runtime.runPromise(
				CloudAuth.use((auth) => auth.getSessionWithHeaders(headers)).pipe(
					Effect.map((result) => ({ session: projectSession(result.response), headers: result.headers })),
				),
			),
		dispose: () => Promise.all([dashboard.dispose(), runtime.dispose()]).then(() => undefined),
	};
};

declare global {
	var chirpCloudAuthRuntime: AuthRequestRuntime | undefined;
}

const live = (globalThis.chirpCloudAuthRuntime ??= makeAuthRequestRuntime(cloudAuthSettings));

export const handleAuthRequest = live.handle;
export const getAuthSession = live.getSession;
export const getAuthSessionWithHeaders = live.getSessionWithHeaders;
export const getAuthPublicOrigin = live.getPublicOrigin;
export const dashboardRequestRuntime = live.dashboard;
export const disposeCloudRequestRuntime = async () => {
	if (globalThis.chirpCloudAuthRuntime === live) globalThis.chirpCloudAuthRuntime = undefined;
	await live.dispose();
};
