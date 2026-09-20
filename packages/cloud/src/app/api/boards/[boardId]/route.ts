import { dashboardHttp } from "../../../../dashboard-http.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = (request: Request, context: { readonly params: Promise<{ readonly boardId: string }> }) =>
	context.params.then(({ boardId }) => dashboardHttp.detail(request, boardId));
