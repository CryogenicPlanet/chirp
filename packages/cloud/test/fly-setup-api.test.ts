import { Effect, Layer, Redacted, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, expect, test, vi } from "vitest";
import { FlySetupApi, flySetupApiLayer } from "../src/fly-setup-api.ts";

afterEach(() => vi.restoreAllMocks());

test("fixed exec argv, strict ephemeral payload and sanitized provider failures", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	vi.spyOn(Date, "now").mockReturnValue(now);
	for (const mode of [
		"ok",
		"closed",
		"expired",
		"skewed",
		"long",
		"extra",
		"exit",
		"unsupported",
		"missing-script",
		"near-missing-script",
		"status",
	] as const) {
		const stdout =
			mode === "closed"
				? { error: "setup_closed" }
				: {
						code: "a".repeat(32),
						expires_at:
							mode === "expired"
								? now - 1
								: mode === "skewed"
									? now + 959000
									: mode === "long"
										? now + 961000
										: now + 890000,
						...(mode === "extra" ? { secret: "raw-secret" } : {}),
					};
		const layer = flySetupApiLayer({ token: Redacted.make("secret"), baseUrl: "https://fly.test" }).pipe(
			Layer.provide(
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) => {
						expect(request.url).toBe("https://fly.test/v1/apps/app/machines/machine/exec");
						expect(request.method).toBe("POST");
						expect(request.body._tag).toBe("Uint8Array");
						if (request.body._tag === "Uint8Array")
							expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
								command: ["/usr/local/bin/bun", "/opt/comms/packages/boot/dist/setup-code.js"],
								timeout: 5,
							});
						return Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								Response.json(
									{
										exit_code:
											mode === "exit" || mode === "missing-script" || mode === "near-missing-script"
												? 1
												: mode === "unsupported"
													? 127
													: 0,
										stdout: mode === "missing-script" || mode === "near-missing-script" ? "" : JSON.stringify(stdout),
										stderr:
											mode === "missing-script"
												? 'error: Module not found "/opt/comms/packages/boot/dist/setup-code.js"\n'
												: mode === "near-missing-script"
													? 'error: Module not found "/data/secret.js"\n'
													: "raw-secret",
									},
									{ status: mode === "status" ? 503 : 200 },
								),
							),
						);
					}),
				),
			),
		);
		const result = await Effect.runPromise(
			FlySetupApi.use((api) => Effect.result(api.issue("app", "machine"))).pipe(Effect.provide(layer)),
		);
		expect(Result.isSuccess(result)).toBe(mode === "ok" || mode === "skewed");
		expect(JSON.stringify(result)).not.toContain("raw-secret");
		if (mode === "missing-script" || mode === "unsupported")
			expect(result).toMatchObject({ failure: { code: "setup_code_unsupported" } });
		if (mode === "near-missing-script") expect(result).toMatchObject({ failure: { code: "setup_code_unavailable" } });
		if (mode === "closed") expect(result).toMatchObject({ failure: { code: "setup_closed" } });
	}
});
