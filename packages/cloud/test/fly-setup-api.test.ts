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
			FlySetupApi.use((api) => Effect.result(api.issue("app", "machine", []))).pipe(Effect.provide(layer)),
		);
		expect(Result.isSuccess(result)).toBe(mode === "ok" || mode === "skewed");
		expect(JSON.stringify(result)).not.toContain("raw-secret");
		if (mode === "missing-script" || mode === "unsupported")
			expect(result).toMatchObject({ failure: { code: "setup_code_unsupported" } });
		if (mode === "near-missing-script") expect(result).toMatchObject({ failure: { code: "setup_code_unavailable" } });
		if (mode === "closed") expect(result).toMatchObject({ failure: { code: "setup_closed" } });
	}
});

const execLayer = (reply: (command: unknown) => Response) =>
	flySetupApiLayer({ token: Redacted.make("secret"), baseUrl: "https://fly.test" }).pipe(
		Layer.provide(
			Layer.succeed(
				HttpClient.HttpClient,
				HttpClient.make((request) =>
					Effect.succeed(
						HttpClientResponse.fromWeb(
							request,
							reply(
								request.body._tag === "Uint8Array"
									? JSON.parse(new TextDecoder().decode(request.body.body)).command
									: undefined,
							),
						),
					),
				),
			),
		),
	);

test("identities ride as one JSON argument; new and old images both decode", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	vi.spyOn(Date, "now").mockReturnValue(now);
	const identities = [
		{ subject: "github:583231", label: 'Rahul "quoted" $(id)' },
		{ subject: "google:1234567890", label: "Rahul" },
	];
	for (const [reply, expected] of [
		[{ identities: 2 }, Result.succeed(2)],
		[{}, Result.succeed(0)],
		[{ identities: 3 }, Result.fail("setup_code_unavailable")],
		[{ identities: 1, linked: ["github:583231"] }, Result.fail("setup_code_unavailable")],
	] as const) {
		let command: unknown;
		const result = await Effect.runPromise(
			FlySetupApi.use((api) => Effect.result(api.issue("app", "machine", identities))).pipe(
				Effect.provide(
					execLayer((sent) => {
						command = sent;
						return Response.json({
							exit_code: 0,
							stdout: JSON.stringify({ code: "a".repeat(16), expires_at: now + 890000, ...reply }),
						});
					}),
				),
			),
		);
		expect(command).toEqual([
			"/usr/local/bin/bun",
			"/opt/comms/packages/boot/dist/setup-code.js",
			JSON.stringify({ identities }),
		]);
		expect(
			Result.isSuccess(result) ? Result.succeed(result.success.identities) : Result.fail(result.failure.code),
		).toEqual(expected);
	}
});

test("auth state is a bounded, non-redirecting public read of setup_required", async () => {
	for (const [status, body, expected] of [
		[200, JSON.stringify({ setup_required: true, authenticated: false }), Result.succeed(true)],
		[200, JSON.stringify({ setup_required: false, authenticated: false, later: 1 }), Result.succeed(false)],
		[200, JSON.stringify({ setup_required: "yes" }), Result.fail("setup_code_unavailable")],
		[200, JSON.stringify({ setup_required: false, padding: "x".repeat(5000) }), Result.fail("setup_code_unavailable")],
		[302, "", Result.fail("setup_code_unavailable")],
		[503, JSON.stringify({ setup_required: false }), Result.fail("setup_code_unavailable")],
	] as const) {
		const layer = flySetupApiLayer({ token: Redacted.make("secret") }).pipe(
			Layer.provide(
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) => {
						expect(request.url).toBe("https://board.test/_boot/auth/state");
						expect(request.method).toBe("GET");
						expect(request.headers["authorization"]).toBeUndefined();
						return Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								new Response(status === 302 ? null : body, {
									status,
									headers: status === 302 ? { location: "https://elsewhere.test/" } : {},
								}),
							),
						);
					}),
				),
			),
		);
		const result = await Effect.runPromise(
			FlySetupApi.use((api) => Effect.result(api.setupRequired("board.test"))).pipe(Effect.provide(layer)),
		);
		expect(Result.isSuccess(result) ? Result.succeed(result.success) : Result.fail(result.failure.code)).toEqual(
			expected,
		);
	}
});
