import { headers } from "next/headers";
import { getAuthSession } from "../../../auth-runtime.ts";
import { BoardDetail } from "./board-detail.tsx";

export default async function BoardPage({ params }: { readonly params: Promise<{ readonly boardId: string }> }) {
	const { boardId } = await params;
	try {
		const session = await getAuthSession(new Headers(await headers()));
		return <BoardDetail authUnavailable={false} boardId={boardId} sessionUser={session?.user ?? null} />;
	} catch {
		return <BoardDetail authUnavailable boardId={boardId} sessionUser={null} />;
	}
}
