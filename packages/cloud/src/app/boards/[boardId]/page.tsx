import { headers } from "next/headers";
import { getAuthSession } from "../../../auth-runtime.ts";
import { BoardDetail } from "./board-detail.tsx";

export default async function BoardPage({
	params,
	searchParams,
}: {
	readonly params: Promise<{ readonly boardId: string }>;
	readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}) {
	const { boardId } = await params;
	// Open board on the dashboard lands here with ?setup=1 when the board needs the copy-code panel.
	const openSetup = (await searchParams)["setup"] === "1";
	try {
		const session = await getAuthSession(new Headers(await headers()));
		return (
			<BoardDetail
				authUnavailable={false}
				boardId={boardId}
				openSetup={openSetup}
				sessionUser={session?.user ?? null}
			/>
		);
	} catch {
		return <BoardDetail authUnavailable boardId={boardId} openSetup={openSetup} sessionUser={null} />;
	}
}
