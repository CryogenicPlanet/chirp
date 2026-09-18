import type { Api } from "../../packages/server/src/kernel/extension-api.ts";

/** Optional anonymous publication of pages/public. Installing this file is an explicit publication decision. */
export default function publicPages(api: Api) {
	for (const method of ["GET", "HEAD"] as const)
		for (const path of ["/public", "/public/*"] as const)
			api.route(method, path, {
				access: "application-managed",
				description: "Read files under pages/public without board authentication. Requires applicationManagedIngress.",
				handler: (request, ctx) => ctx.pages.serve(request, { root: "public", mount: "/public" }),
			});
}
