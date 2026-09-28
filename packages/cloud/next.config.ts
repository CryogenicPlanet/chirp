import type { NextConfig } from "next";

const config: NextConfig = {
	// PostHog request paths end in a slash; a redirect would double every `/ingest` request.
	skipTrailingSlashRedirect: true,
};

export default config;
