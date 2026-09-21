import { connection } from "next/server";
import { getAuthProviders } from "../../auth-runtime.ts";
import { InvitationPage } from "./invitation-page.tsx";

export default async function Page() {
	await connection();
	try {
		return <InvitationPage providers={await getAuthProviders()} />;
	} catch {
		return <InvitationPage providers={[]} authUnavailable />;
	}
}
