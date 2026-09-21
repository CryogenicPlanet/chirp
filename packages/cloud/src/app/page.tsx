import { headers } from "next/headers";
import { getAuthProviders, getAuthSession } from "../auth-runtime.ts";
import { CloudApp } from "./cloud-app.tsx";

export default async function Home() {
	try {
		const session = await getAuthSession(new Headers(await headers()));
		return (
			<CloudApp authUnavailable={false} providers={await getAuthProviders()} sessionUser={session?.user ?? null} />
		);
	} catch {
		return <CloudApp authUnavailable providers={[]} sessionUser={null} />;
	}
}
