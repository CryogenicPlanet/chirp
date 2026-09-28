import { Config, Data, Effect, Option } from "effect";
import { hasAuthoritativeClientIp } from "./client-ip-boundary.ts";

export interface PostHogSettings {
	/** Public by design: a project token only authorizes sending events. */
	readonly projectToken: string;
	readonly ingestOrigin: string;
	readonly assetsOrigin: string;
	readonly clientIpHeader: string | undefined;
}

export class PostHogConfigurationError extends Data.TaggedError("PostHogConfigurationError")<{
	readonly message: string;
}> {}

export const postHogSettings = Effect.gen(function* () {
	const values = yield* Config.all({
		projectToken: Config.option(Config.String("POSTHOG_PROJECT_TOKEN")),
		host: Config.URL("POSTHOG_HOST").pipe(Config.withDefault(new URL("https://us.i.posthog.com"))),
		clientIpHeader: Config.option(Config.String("CLOUD_CLIENT_IP_HEADER")),
	});
	const projectToken = Option.getOrUndefined(values.projectToken)?.trim();
	if (!projectToken) return undefined;
	const region = /^(us|eu)\.i\.posthog\.com$/.exec(values.host.hostname)?.[1];
	if (!region || values.host.protocol !== "https:" || values.host.pathname !== "/")
		return yield* new PostHogConfigurationError({
			message: "POSTHOG_HOST must be https://us.i.posthog.com or https://eu.i.posthog.com",
		});
	return {
		projectToken,
		ingestOrigin: values.host.origin,
		assetsOrigin: `https://${region}-assets.i.posthog.com`,
		clientIpHeader: Option.getOrUndefined(values.clientIpHeader)?.trim(),
	} satisfies PostHogSettings;
});

/** Analytics are optional: a bad configuration is logged and disables them rather than failing the page. */
export const loadPostHogSettings = () =>
	Effect.runPromise(
		postHogSettings.pipe(
			Effect.catch((error) => Effect.logError("PostHog analytics disabled", error.message).pipe(Effect.as(undefined))),
		),
	);

const forwardedHeaders = ["content-type", "content-encoding", "user-agent"] as const;

/** Builds the upstream request for `/ingest/*`, forwarding only what PostHog needs and never Cloud cookies. */
export const postHogRequest = (request: Request, path: ReadonlyArray<string>, settings: PostHogSettings) => {
	const incoming = new URL(request.url);
	const origin = path[0] === "array" ? settings.assetsOrigin : settings.ingestOrigin;
	const trailingSlash = incoming.pathname.endsWith("/") ? "/" : "";
	const target = new URL(`${origin}/${path.map(encodeURIComponent).join("/")}${trailingSlash}${incoming.search}`);
	const headers = new Headers();
	for (const name of forwardedHeaders) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const clientIp =
		settings.clientIpHeader && hasAuthoritativeClientIp(request.headers, settings.clientIpHeader)
			? request.headers.get(settings.clientIpHeader)?.trim()
			: undefined;
	if (clientIp) headers.set("x-forwarded-for", clientIp);
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return new Request(target, {
		method: request.method,
		headers,
		body: hasBody ? request.body : null,
		redirect: "manual",
		...(hasBody ? { duplex: "half" } : {}),
	});
};
