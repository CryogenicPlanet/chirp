"use client";

import posthog from "posthog-js";
import { createContext, type ReactNode, useContext, useEffect } from "react";

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

const ProjectToken = createContext<string | undefined>(undefined);

export function AnalyticsProvider({
	projectToken,
	children,
}: {
	readonly projectToken: string | undefined;
	readonly children: ReactNode;
}) {
	return <ProjectToken value={projectToken}>{children}</ProjectToken>;
}

const syncIdentity = (user: AnalyticsUser | null) => {
	if (user) posthog.identify(user.id, { email: user.email, name: user.name });
	else if (posthog._isIdentified()) posthog.reset();
};

/**
 * Starts analytics on a page and keeps PostHog's identity in step with the Cloud session,
 * so signed-out visits are never credited to the last account.
 */
export const useAnalyticsIdentity = (user: AnalyticsUser | null) => {
	const projectToken = useContext(ProjectToken);
	useEffect(() => {
		if (!projectToken) return;
		if (posthog.__loaded) {
			syncIdentity(user);
			return;
		}
		posthog.init(projectToken, {
			api_host: "/ingest",
			defaults: "2026-08-30",
			// PostHog captures the first pageview after `loaded`, so it carries this session's identity.
			loaded: () => syncIdentity(user),
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
	}, [projectToken, user]);
};

export const track = (event: CloudEvent, properties?: Readonly<Record<string, string | boolean>>) => {
	if (posthog.__loaded) posthog.capture(event, properties);
};
