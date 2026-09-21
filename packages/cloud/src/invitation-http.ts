import { Effect, Schema } from "effect";
import { dashboardRequestRuntime, getAuthPublicOrigin, getAuthSessionWithHeaders } from "./auth-runtime.ts";
import { InvitationCreateRequest } from "./invitation-contract.ts";

interface InvitationHttpDependencies {
	readonly getSession: typeof getAuthSessionWithHeaders;
	readonly getPublicOrigin: typeof getAuthPublicOrigin;
	readonly canInvite: typeof dashboardRequestRuntime.canInvite;
	readonly invite: typeof dashboardRequestRuntime.invite;
}

const error = (status: number, code: string, headers: Headers) =>
	Response.json({ error: { code } }, { status, headers });
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeRequest = async (request: Request) => {
	const lengthHeader = request.headers.get("content-length");
	if (lengthHeader && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > 4_096)) return null;
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
		if (Object.keys(body).some((key) => key !== "email")) return null;
		return Schema.decodeUnknownSync(InvitationCreateRequest)(body);
	} catch {
		return null;
	}
};

export const makeInvitationHttp = (dependencies: InvitationHttpDependencies) => {
	const sessionUser = async (request: Request, headers: Headers) => {
		try {
			const result = await dependencies.getSession(request.headers);
			for (const [key, value] of result.headers) headers.append(key, value);
			return result.session?.user ?? error(401, "unauthorized", headers);
		} catch {
			return error(503, "authentication_unavailable", headers);
		}
	};
	return {
		capability: async (request: Request) => {
			const headers = new Headers({ "cache-control": "no-store" });
			const user = await sessionUser(request, headers);
			if (user instanceof Response) return user;
			try {
				return Response.json({ can_invite: await dependencies.canInvite(user.email) }, { headers });
			} catch {
				return error(503, "invitations_unavailable", headers);
			}
		},
		create: async (request: Request) => {
			const headers = new Headers({ "cache-control": "no-store" });
			const user = await sessionUser(request, headers);
			if (user instanceof Response) return user;
			try {
				const origin = await dependencies.getPublicOrigin();
				if (request.headers.get("origin") !== origin) return error(403, "origin_rejected", headers);
				if (!(await dependencies.canInvite(user.email))) return error(403, "invitations_forbidden", headers);
				if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
					return error(400, "invalid_request", headers);
				const body = await decodeRequest(request);
				if (!body) return error(400, "invalid_request", headers);
				const result = await dependencies.invite({ id: user.id, email: user.email }, body.email);
				if (!result.ok)
					return error(
						result.code === "invitation_rate_limited" ? 429 : result.code === "invitations_forbidden" ? 403 : 400,
						result.code,
						headers,
					);
				return Response.json(
					{ url: `${origin}/invite#${result.token}`, expires_at: result.expires_at },
					{ status: 201, headers },
				);
			} catch {
				await Effect.runPromise(Effect.logError("Chirp Cloud invitation issuance failed"));
				return error(503, "invitations_unavailable", headers);
			}
		},
	};
};

export const invitationHttp = makeInvitationHttp({
	getSession: getAuthSessionWithHeaders,
	getPublicOrigin: getAuthPublicOrigin,
	canInvite: dashboardRequestRuntime.canInvite,
	invite: dashboardRequestRuntime.invite,
});
