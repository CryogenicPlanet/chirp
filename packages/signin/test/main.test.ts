import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Redacted } from "effect";
import { expect, it } from "vitest";
import { documentServer, rawSettings } from "./fixtures/signin.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const freePort = async () => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
	return address.port;
};

/** The real entry point under Bun, as Fly runs it, with output captured. */
const launch = async (overrides: Record<string, string> = {}) => {
	const raw = await rawSettings();
	const port = await freePort();
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		PORT: String(port),
		SIGNIN_ISSUER: `http://127.0.0.1:${port}`,
		SIGNIN_SIGNING_KEY: Redacted.value(raw.signingKey),
		SIGNIN_SEAL_KEY: Redacted.value(raw.sealKey),
		GITHUB_CLIENT_ID: "gh-client",
		GITHUB_CLIENT_SECRET: "gh-secret-value",
		GOOGLE_CLIENT_ID: "google-client",
		GOOGLE_CLIENT_SECRET: "google-secret-value",
		...overrides,
	};
	const child: ChildProcess = spawn("bun", [main], { env, stdio: ["ignore", "pipe", "pipe"] });
	const output: Array<string> = [];
	child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
	return { child, env, origin: env.SIGNIN_ISSUER, output: () => output.join("") };
};

const ready = async (origin: string) => {
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await fetch(`${origin}/health`).catch(() => undefined);
		if (response?.ok) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("signin did not become ready");
};

it("serves under Bun with the production client policy and keeps secrets out of its output", async () => {
	const service = await launch();
	const clients = await documentServer();
	try {
		await ready(service.origin);
		const discovery = await (await fetch(`${service.origin}/.well-known/openid-configuration`)).json();
		expect(discovery.issuer).toBe(service.origin);
		// main.ts wires the production layer: a loopback client document is never fetched.
		const authorize = new URL("/authorize", service.origin);
		for (const [name, value] of Object.entries({
			response_type: "code",
			client_id: clients.board(),
			redirect_uri: "https://board.test/auth/oidc/callback",
			state: "secret-state-456",
			nonce: "secret-nonce-123",
			code_challenge: "A".repeat(43),
			code_challenge_method: "S256",
			scope: "openid",
			provider: "github",
		}))
			authorize.searchParams.set(name, value);
		const refused = await fetch(authorize, { redirect: "manual" });
		expect(refused.status).toBe(400);
		expect(refused.headers.get("location")).toBeNull();
		const callback = await fetch(`${service.origin}/callback/github?code=secret-code-789&state=x`);
		expect(callback.status).toBe(400);
	} finally {
		service.child.kill("SIGTERM");
		await once(service.child, "exit");
		await clients.close();
	}
	const output = service.output();
	for (const secret of [
		"secret-state-456",
		"secret-nonce-123",
		"secret-code-789",
		"gh-secret-value",
		"google-secret-value",
		service.env.SIGNIN_SEAL_KEY,
		service.env.SIGNIN_SIGNING_KEY,
	])
		expect(output).not.toContain(secret);
}, 20_000);

it("refuses to start on a bad setting and names it without its value", async () => {
	const service = await launch({ SIGNIN_SEAL_KEY: "not-a-real-seal-key" });
	const [code] = await once(service.child, "exit");
	expect(code).not.toBe(0);
	expect(service.output()).toContain("SIGNIN_SEAL_KEY is missing or invalid");
	expect(service.output()).not.toContain("not-a-real-seal-key");
}, 20_000);
