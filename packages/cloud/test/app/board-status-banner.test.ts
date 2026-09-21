import { describe, expect, test } from "vitest";
import { boardStatusBanner } from "../../src/app/board-status-banner.ts";

describe("board status banner", () => {
	test("reports a terminal provisioning failure as terminal without promising a retry", () => {
		const banner = boardStatusBanner({
			error: {
				code: "retry_exhausted",
				message: "Provisioning failure limit reached: machine_start_ambiguous.",
				retrying: false,
				severity: "error",
			},
		});
		expect(banner).toEqual({
			severity: "error",
			label: "retry exhausted",
			message: "Provisioning failure limit reached: machine_start_ambiguous.",
			note: "Setup stopped and will not retry on its own. Contact your Cloud administrator for help.",
		});
	});
	test("reports a pending provider observation as progress rather than a warning", () => {
		const banner = boardStatusBanner({
			error: {
				code: "provider_observation_pending",
				message: "Fly Machine health check is not passing",
				retrying: true,
				severity: "progress",
			},
		});
		expect(banner?.severity).toBe("progress");
		expect(banner?.label).toBe("Setup in progress");
		expect(banner?.note).not.toContain("attention");
	});
	test("keeps a retriable provider failure a warning that names the code", () => {
		const banner = boardStatusBanner({
			error: { code: "provider_unavailable", message: "Fly will be retried", retrying: true, severity: "warning" },
		});
		expect(banner).toMatchObject({
			severity: "warning",
			label: "provider unavailable",
			note: "We’ll retry automatically.",
		});
	});
	test("shows nothing when no error is recorded", () => {
		expect(boardStatusBanner({ error: null })).toBeNull();
	});
});
