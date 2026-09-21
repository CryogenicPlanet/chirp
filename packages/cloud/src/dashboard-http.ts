import { Effect, Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSessionWithHeaders } from "./auth-runtime.ts";
import { DashboardCreateRequest, type DashboardBoard } from "./dashboard-contract.ts";

interface DashboardHttpDependencies {
	readonly getSession: typeof getAuthSessionWithHeaders;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
	readonly list: typeof dashboardRequestRuntime.list;
	readonly get: typeof dashboardRequestRuntime.get;
	readonly create: typeof dashboardRequestRuntime.create;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isBoardId = Schema.is(Schema.String.check(Schema.isUUID()));
const responseHeaders = (sessionHeaders?: Headers) => {
	const headers = new Headers(sessionHeaders);
	headers.set("cache-control", "no-store");
	return headers;
};
const error = (status: number, code: string, sessionHeaders?: Headers) =>
	Response.json({ error: { code } }, { status, headers: responseHeaders(sessionHeaders) });

const sessionOwner = async (request: Request, dependencies: DashboardHttpDependencies) => {
	try {
		const result = await dependencies.getSession(request.headers);
		return { ownerId: result.session?.user.id ?? null, headers: result.headers };
	} catch (cause) {
		await Effect.runPromise(Effect.logError("Chirp Cloud dashboard session lookup failed", cause));
		return { ownerId: undefined, headers: new Headers() };
	}
};

const decodeCreateRequest = async (request: Request) => {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 4_096)) return null;
	try {
		if (!request.body) return null;
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
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
			offset += chunk.byteLength;
		}
		const body = decodeJson(new TextDecoder().decode(bytes));
		if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
		if (Object.keys(body).some((key) => key !== "name")) return null;
		return Schema.decodeUnknownSync(DashboardCreateRequest)(body);
	} catch {
		return null;
	}
};

export const makeDashboardHttp = (dependencies: DashboardHttpDependencies) => ({
	list: async (request: Request) => {
		const session = await sessionOwner(request, dependencies);
		if (session.ownerId === null) return error(401, "unauthorized", session.headers);
		if (session.ownerId === undefined) return error(503, "authentication_unavailable", session.headers);
		try {
			return Response.json(await dependencies.list(session.ownerId), { headers: responseHeaders(session.headers) });
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard list failed", cause));
			return error(503, "dashboard_unavailable", session.headers);
		}
	},
	create: async (request: Request) => {
		const session = await sessionOwner(request, dependencies);
		if (session.ownerId === null) return error(401, "unauthorized", session.headers);
		if (session.ownerId === undefined) return error(503, "authentication_unavailable", session.headers);
		try {
			if (request.headers.get("origin") !== (await dependencies.getPublicOrigin()))
				return error(403, "origin_rejected", session.headers);
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard origin lookup failed", cause));
			return error(503, "authentication_unavailable", session.headers);
		}
		if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
			return error(400, "invalid_request", session.headers);
		const idempotencyKey = request.headers.get("idempotency-key")?.trim();
		if (!idempotencyKey || idempotencyKey.length > 200) return error(400, "invalid_idempotency_key", session.headers);
		const body = await decodeCreateRequest(request);
		if (!body || body.name.trim().length < 1 || body.name.trim().length > 80)
			return error(400, "invalid_request", session.headers);
		try {
			const result = await dependencies.create(session.ownerId, {
				name: body.name,
				idempotency_key: idempotencyKey,
			});
			if (!result.ok)
				return error(
					result.code === "idempotency_conflict" ? 409 : result.code === "board_quota_exceeded" ? 403 : 400,
					result.code,
					session.headers,
				);
			return Response.json(
				{ board: result.board },
				{
					status: 201,
					headers: (() => {
						const headers = responseHeaders(session.headers);
						headers.set("location", `/boards/${encodeURIComponent(result.board.id)}`);
						return headers;
					})(),
				},
			);
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard create failed", cause));
			return error(503, "dashboard_unavailable", session.headers);
		}
	},
	detail: async (request: Request, boardId: string) => {
		const session = await sessionOwner(request, dependencies);
		if (session.ownerId === null) return error(401, "unauthorized", session.headers);
		if (session.ownerId === undefined) return error(503, "authentication_unavailable", session.headers);
		if (!isBoardId(boardId)) return error(404, "not_found", session.headers);
		try {
			const board = await dependencies.get(session.ownerId, boardId);
			return board._tag === "None"
				? error(404, "not_found", session.headers)
				: Response.json({ board: board.value satisfies DashboardBoard }, { headers: responseHeaders(session.headers) });
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard detail failed", cause));
			return error(503, "dashboard_unavailable", session.headers);
		}
	},
});

export const dashboardHttp = makeDashboardHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	list: dashboardRequestRuntime.list,
	get: dashboardRequestRuntime.get,
	create: dashboardRequestRuntime.create,
});
