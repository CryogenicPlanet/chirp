import { Effect, Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSessionWithHeaders } from "./auth-runtime.ts";
import { DashboardDeleteRequest } from "./dashboard-contract.ts";

interface Dependencies {
	readonly getSession: typeof getAuthSessionWithHeaders;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
	readonly remove: typeof dashboardRequestRuntime.remove;
}
const error = (status: number, code: string, headers: Headers) =>
	Response.json({ error: { code } }, { status, headers });
const isBoardId = Schema.is(Schema.String.check(Schema.isUUID()));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DashboardDeleteRequest), { onExcessProperty: "error" });
const read = async (request: Request) => {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > 4_096) {
				await reader.cancel();
				return null;
			}
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const body = decode(new TextDecoder().decode(bytes));
		return body.confirmation_name.length > 0 && body.confirmation_name.length <= 80 ? body : null;
	} catch {
		return null;
	}
};
export const makeBoardDeletionHttp = (dependencies: Dependencies) => async (request: Request, boardId: string) => {
	const headers = new Headers({ "cache-control": "no-store" });
	try {
		const resultSession = await dependencies.getSession(request.headers);
		for (const [key, value] of resultSession.headers) headers.append(key, value);
		const session = resultSession.session;
		if (!session) return error(401, "unauthorized", headers);
		if (!isBoardId(boardId)) return error(404, "not_found", headers);
		if (request.headers.get("origin") !== (await dependencies.getPublicOrigin()))
			return error(403, "origin_rejected", headers);
		if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
			return error(400, "invalid_request", headers);
		const key = request.headers.get("idempotency-key")?.trim();
		if (!key || key.length > 200) return error(400, "invalid_idempotency_key", headers);
		const body = await read(request);
		if (!body) return error(400, "invalid_request", headers);
		const result = await dependencies.remove(session.user.id, boardId, { ...body, idempotency_key: key });
		if (!result.ok)
			return error(
				result.code === "not_found" ? 404 : result.code === "confirmation_mismatch" ? 400 : 409,
				result.code,
				headers,
			);
		return "deleted" in result
			? Response.json({ deleted: true }, { headers })
			: Response.json({ board: result.board }, { status: 202, headers });
	} catch (cause) {
		await Effect.runPromise(Effect.logError("Chirp Cloud board deletion failed", cause));
		return error(503, "dashboard_unavailable", headers);
	}
};
export const deleteBoardHttp = makeBoardDeletionHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	remove: dashboardRequestRuntime.remove,
});
