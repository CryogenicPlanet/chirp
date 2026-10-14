import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Redacted } from "effect";
import { expect, it } from "vitest";
import * as Settings from "../src/settings.ts";
import { rawSettings } from "./fixtures/signin.ts";

const keygen = fileURLToPath(new URL("../scripts/keygen.ts", import.meta.url));
const settingsError = (raw: Settings.RawSettings) =>
	Effect.runPromise(
		Settings.parse(raw).pipe(
			Effect.map(() => "ok"),
			Effect.catchTag("SettingsError", (error) => Effect.succeed(error.message)),
		),
	);

it("accepts the keys the keygen script prints", async () => {
	const { stdout } = await promisify(execFile)("bun", [keygen]);
	const lines = Object.fromEntries(
		stdout
			.trim()
			.split("\n")
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
	expect(Object.keys(lines)).toEqual(["SIGNIN_SIGNING_KEY", "SIGNIN_SEAL_KEY"]);
	const raw = await rawSettings();
	const parsed = await Effect.runPromise(
		Settings.parse({
			...raw,
			signingKey: Redacted.make(lines.SIGNIN_SIGNING_KEY ?? ""),
			sealKey: Redacted.make(lines.SIGNIN_SEAL_KEY ?? ""),
		}),
	);
	expect(parsed.signing.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
	expect(parsed.signing.publicJwk).not.toHaveProperty("d");
	expect(parsed.signing.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

it("names the bad variable without echoing its value", async () => {
	const raw = await rawSettings();
	const secret = "0123456789abcdef-not-hex";
	expect(await settingsError({ ...raw, sealKey: Redacted.make(secret) })).toBe("SIGNIN_SEAL_KEY is missing or invalid");
	expect(await settingsError({ ...raw, signingKey: Redacted.make(`{"kty":"oct","k":"${secret}"}`) })).toBe(
		"SIGNIN_SIGNING_KEY is missing or invalid",
	);
	for (const issuer of ["https://auth.chirp.wiki/", "https://auth.chirp.wiki/x", "http://auth.chirp.wiki"])
		expect(await settingsError({ ...raw, issuer })).toBe("SIGNIN_ISSUER is missing or invalid");
	expect(await settingsError({ ...raw, google: { clientId: "google-client", clientSecret: Redacted.make("") } })).toBe(
		"GOOGLE_CLIENT_SECRET is missing or invalid",
	);
	expect(await settingsError({ ...raw, github: { clientId: "", clientSecret: Redacted.make("x") } })).toBe(
		"GITHUB_CLIENT_ID is missing or invalid",
	);
});
