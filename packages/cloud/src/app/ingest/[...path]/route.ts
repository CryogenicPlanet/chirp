import { loadPostHogSettings, postHogRequest } from "../../../posthog.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A first-party path keeps analytics working under tracker blocklists without sending Cloud cookies to PostHog.
const forward = async (
	request: Request,
	context: { readonly params: Promise<{ readonly path: ReadonlyArray<string> }> },
) => {
	const settings = await loadPostHogSettings();
	if (!settings) return new Response(null, { status: 404 });
	try {
		const upstream = await fetch(postHogRequest(request, (await context.params).path, settings));
		const headers = new Headers({ "x-content-type-options": "nosniff" });
		for (const name of ["content-type", "cache-control"]) {
			const value = upstream.headers.get(name);
			if (value) headers.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers });
	} catch {
		return new Response(null, { status: 502 });
	}
};

export const GET = forward;
export const POST = forward;
