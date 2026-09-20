import { Effect, Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSession } from "./auth-runtime.ts";
import { DashboardCreateRequest, type DashboardBoard } from "./dashboard-contract.ts";

interface DashboardHttpDependencies {
	readonly getSession: typeof getAuthSession;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
	readonly list: typeof dashboardRequestRuntime.list;
	readonly get: typeof dashboardRequestRuntime.get;
	readonly create: typeof dashboardRequestRuntime.create;
}

const noStore = { "cache-control": "no-store" };
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isBoardId = Schema.is(Schema.String.check(Schema.isUUID()));
const error = (status: number, code: string) => Response.json({ error: { code } }, { status, headers: noStore });

const sessionOwner = async (request: Request, dependencies: DashboardHttpDependencies) => {
	try {
		return (await dependencies.getSession(request.headers))?.user.id ?? null;
	} catch (cause) {
		await Effect.runPromise(Effect.logError("Chirp Cloud dashboard session lookup failed", cause));
		return undefined;
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
		const ownerId = await sessionOwner(request, dependencies);
		if (ownerId === null) return error(401, "unauthorized");
		if (ownerId === undefined) return error(503, "authentication_unavailable");
		try {
			return Response.json(await dependencies.list(ownerId), { headers: noStore });
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard list failed", cause));
			return error(503, "dashboard_unavailable");
		}
	},
	create: async (request: Request) => {
		const ownerId = await sessionOwner(request, dependencies);
		if (ownerId === null) return error(401, "unauthorized");
		if (ownerId === undefined) return error(503, "authentication_unavailable");
		try {
			if (request.headers.get("origin") !== (await dependencies.getPublicOrigin()))
				return error(403, "origin_rejected");
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard origin lookup failed", cause));
			return error(503, "authentication_unavailable");
		}
		if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
			return error(400, "invalid_request");
		const idempotencyKey = request.headers.get("idempotency-key")?.trim();
		if (!idempotencyKey || idempotencyKey.length > 200) return error(400, "invalid_idempotency_key");
		const body = await decodeCreateRequest(request);
		if (!body || body.name.trim().length < 1 || body.name.trim().length > 80) return error(400, "invalid_request");
		try {
			const result = await dependencies.create(ownerId, {
				name: body.name,
				idempotency_key: idempotencyKey,
			});
			if (!result.ok)
				return error(
					result.code === "idempotency_conflict" ? 409 : result.code === "board_quota_exceeded" ? 403 : 400,
					result.code,
				);
			return Response.json(
				{ board: result.board },
				{
					status: 201,
					headers: { ...noStore, location: `/boards/${encodeURIComponent(result.board.id)}` },
				},
			);
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard create failed", cause));
			return error(503, "dashboard_unavailable");
		}
	},
	detail: async (request: Request, boardId: string) => {
		const ownerId = await sessionOwner(request, dependencies);
		if (ownerId === null) return error(401, "unauthorized");
		if (ownerId === undefined) return error(503, "authentication_unavailable");
		if (!isBoardId(boardId)) return error(404, "not_found");
		try {
			const board = await dependencies.get(ownerId, boardId);
			return board._tag === "None"
				? error(404, "not_found")
				: Response.json({ board: board.value satisfies DashboardBoard }, { headers: noStore });
		} catch (cause) {
			await Effect.runPromise(Effect.logError("Chirp Cloud dashboard detail failed", cause));
			return error(503, "dashboard_unavailable");
		}
	},
});

export const dashboardHttp = makeDashboardHttp({
	getSession: getAuthSession,
	getPublicOrigin: getAuthPublicOrigin,
	list: dashboardRequestRuntime.list,
	get: dashboardRequestRuntime.get,
	create: dashboardRequestRuntime.create,
});
