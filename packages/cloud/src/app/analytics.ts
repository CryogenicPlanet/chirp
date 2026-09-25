"use client";

import posthog from "posthog-js";
import { useEffect } from "react";

/** The product events Cloud records. Board names, addresses, and content never become properties. */
export type CloudEvent =
	| "sign_in_started"
	| "invitation_created"
	| "board_created"
	| "board_opened"
	| "board_deleted"
	| "setup_code_generated"
	| "onboarding_opened";

export function Analytics({ projectToken }: { readonly projectToken: string }) {
	useEffect(() => {
		if (posthog.__loaded) return;
		posthog.init(projectToken, {
			api_host: "/ingest",
			defaults: "2026-08-30",
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
	}, [projectToken]);
	return null;
}

export const identify = (user: { readonly id: string; readonly name: string; readonly email: string }) => {
	if (posthog.__loaded) posthog.identify(user.id, { email: user.email, name: user.name });
};

export const track = (event: CloudEvent, properties?: Readonly<Record<string, string | boolean>>) => {
	if (posthog.__loaded) posthog.capture(event, properties);
};

export const resetAnalytics = () => {
	if (posthog.__loaded) posthog.reset();
};
