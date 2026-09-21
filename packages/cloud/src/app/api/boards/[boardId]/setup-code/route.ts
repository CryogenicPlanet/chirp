import { setupCodeHttp } from "../../../../../board-setup-http.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (request: Request, context: { readonly params: Promise<{ readonly boardId: string }> }) =>
	context.params.then(({ boardId }) => setupCodeHttp(request, boardId));
