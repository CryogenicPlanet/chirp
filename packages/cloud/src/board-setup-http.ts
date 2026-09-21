import { Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSessionWithHeaders } from "./auth-runtime.ts";
interface Dependencies {
	readonly getSession: typeof getAuthSessionWithHeaders;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
	readonly issue: typeof dashboardRequestRuntime.setupCode;
}
const isBoardId = Schema.is(Schema.String.check(Schema.isUUID()));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown), { onExcessProperty: "error" });
const validBody = async (request: Request) => {
	if (!request.body) return false;
	const reader = request.body.getReader();
	let text = "";
	let size = 0;
	const decoder = new TextDecoder();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > 4096) {
				await reader.cancel();
				return false;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		const body = decode(text + decoder.decode());
		return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0;
	} catch {
		return false;
	}
};
export const makeBoardSetupHttp = (dependencies: Dependencies) => async (request: Request, boardId: string) => {
	const headers = new Headers({ "cache-control": "no-store" });
	const error = (status: number, code: string) => Response.json({ error: { code } }, { status, headers });
	try {
		const { session, headers: refreshed } = await dependencies.getSession(request.headers);
		for (const [key, value] of refreshed) headers.append(key, value);
		headers.set("cache-control", "no-store");
		if (!session) return error(401, "unauthorized");
		if (!isBoardId(boardId)) return error(404, "not_found");
		if (request.headers.get("origin") !== (await dependencies.getPublicOrigin())) return error(403, "origin_rejected");
		if (
			request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
			!(await validBody(request))
		)
			return error(400, "invalid_request");
		const result = await dependencies.issue(session.user.id, boardId);
		if (!result.ok)
			return error(result.code === "not_found" ? 404 : result.code === "setup_closed" ? 409 : 503, result.code);
		return Response.json(
			{ code: result.code, expires_at: result.expires_at, onboarding_url: result.onboarding_url },
			{ headers },
		);
	} catch {
		return error(503, "setup_code_unavailable");
	}
};
export const setupCodeHttp = makeBoardSetupHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	issue: dashboardRequestRuntime.setupCode,
});
