"use client";

import { PostHog } from "posthog-js";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

/** The product events Cloud records. Board names, addresses, and content never become properties. */
export type CloudEvent =
	| "sign_in_started"
	| "invitation_created"
	| "board_created"
	| "board_opened"
	| "board_deletion_requested"
	| "setup_code_generated"
	| "onboarding_opened";

interface AnalyticsUser {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

interface Analytics {
	readonly client: PostHog;
	readonly projectToken: string;
}

const AnalyticsContext = createContext<Analytics | undefined>(undefined);

/** Owns the page's PostHog client. Analytics stay off without a project token. */
export function AnalyticsProvider({
	projectToken,
	children,
}: {
	readonly projectToken: string | undefined;
	readonly children: ReactNode;
}) {
	const [analytics] = useState(() => (projectToken ? { client: new PostHog(), projectToken } : undefined));
	return <AnalyticsContext value={analytics}>{children}</AnalyticsContext>;
}

const syncIdentity = (client: PostHog, user: AnalyticsUser | null) => {
	if (user) client.identify(user.id, { email: user.email, name: user.name });
	else if (client._isIdentified()) client.reset();
};

/**
 * Starts analytics on a page and keeps PostHog's identity in step with the Cloud session,
 * so signed-out visits are never credited to the last account.
 */
export const useAnalyticsIdentity = (user: AnalyticsUser | null) => {
	const analytics = useContext(AnalyticsContext);
	useEffect(() => {
		if (!analytics) return;
		const { client, projectToken } = analytics;
		if (client.__loaded) {
			syncIdentity(client, user);
			return;
		}
		client.init(projectToken, {
			api_host: "/ingest",
			defaults: "2026-08-30",
			// PostHog captures the first pageview after `loaded`, so it carries this session's identity.
			loaded: () => syncIdentity(client, user),
			// Invitation links carry their token in the URL fragment.
			disable_capture_url_hashes: true,
			// Named events only: autocapture and replay would record board names, emails, and anything else on screen.
			autocapture: false,
			capture_dead_clicks: false,
			enable_heatmaps: false,
			disable_session_recording: true,
			// PostHog-served scripts never run here, so project settings cannot turn on replay, surveys, or console capture.
			disable_external_dependency_loading: true,
			// A cookie would be scoped to the parent domain and sent to every board.
			persistence: "localStorage",
			cross_subdomain_cookie: false,
		});
	}, [analytics, user]);
};

/** Starts analytics on a server-rendered page reached while signing in. */
export function SignedOutAnalytics() {
	useAnalyticsIdentity(null);
	return null;
}

export const useTrack = () => {
	const analytics = useContext(AnalyticsContext);
	return useCallback(
		(event: CloudEvent, properties?: Readonly<Record<string, string | boolean>>) => {
			if (analytics?.client.__loaded) analytics.client.capture(event, properties);
		},
		[analytics],
	);
};
