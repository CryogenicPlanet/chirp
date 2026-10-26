import { Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSessionWithHeaders } from "./auth-runtime.ts";
interface Guard {
	readonly getSession: typeof getAuthSessionWithHeaders;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
}
interface Dependencies extends Guard {
	readonly issue: typeof dashboardRequestRuntime.setupCode;
}
interface OpenDependencies extends Guard {
	readonly open: typeof dashboardRequestRuntime.openBoard;
}
interface Reply {
	readonly headers: Headers;
	readonly error: (status: number, code: string) => Response;
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
/** A signed-in owner's same-origin POST with an empty JSON body; anything unexpected answers `failure` without detail. */
const ownerBoardPost =
	(guard: Guard, failure: string, respond: (ownerId: string, boardId: string, reply: Reply) => Promise<Response>) =>
	async (request: Request, boardId: string) => {
		const headers = new Headers({ "cache-control": "no-store" });
		const error = (status: number, code: string) => Response.json({ error: { code } }, { status, headers });
		try {
			const { session, headers: refreshed } = await guard.getSession(request.headers);
			for (const [key, value] of refreshed) headers.append(key, value);
			headers.set("cache-control", "no-store");
			if (!session) return error(401, "unauthorized");
			if (!isBoardId(boardId)) return error(404, "not_found");
			if (request.headers.get("origin") !== (await guard.getPublicOrigin())) return error(403, "origin_rejected");
			if (
				request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
				!(await validBody(request))
			)
				return error(400, "invalid_request");
			return await respond(session.user.id, boardId, { headers, error });
		} catch {
			return error(503, failure);
		}
	};
export const makeBoardSetupHttp = (dependencies: Dependencies) =>
	ownerBoardPost(dependencies, "setup_code_unavailable", async (ownerId, boardId, { headers, error }) => {
		const result = await dependencies.issue(ownerId, boardId);
		if (!result.ok)
			return error(result.code === "not_found" ? 404 : result.code === "setup_closed" ? 409 : 503, result.code);
		return Response.json(
			{ code: result.code, expires_at: result.expires_at, onboarding_url: result.onboarding_url },
			{ headers },
		);
	});
/** POST /api/boards/:boardId/open: the board address that signs its owner in, or `setup_code` for the copy-code panel. */
export const makeBoardOpenHttp = (dependencies: OpenDependencies) =>
	ownerBoardPost(dependencies, "board_unavailable", async (ownerId, boardId, { headers, error }) => {
		const result = await dependencies.open(ownerId, boardId);
		if (!result.ok) return error(result.code === "not_found" ? 404 : 503, result.code);
		return Response.json("url" in result ? { url: result.url } : { fallback: result.fallback }, { headers });
	});
export const setupCodeHttp = makeBoardSetupHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	issue: dashboardRequestRuntime.setupCode,
});
export const openBoardHttp = makeBoardOpenHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	open: dashboardRequestRuntime.openBoard,
});
