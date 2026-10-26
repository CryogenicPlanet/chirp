import { openBoardHttp } from "../../../../../board-setup-http.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Where "Open board" sends the signed-in owner: `{ url }` is the board's passkey setup with a prefilled code (and the
 * owner's GitHub or Google identity offered when they have one), or its sign-in page starting that provider. An older
 * image answers `{ fallback: "setup_code", code, expires_at }`: the dashboard shows that code in the copy-code panel.
 * Another owner's board answers 404.
 */
export const POST = (request: Request, context: { readonly params: Promise<{ readonly boardId: string }> }) =>
	context.params.then(({ boardId }) => openBoardHttp(request, boardId));
