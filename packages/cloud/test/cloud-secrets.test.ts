import { ConfigProvider, Effect, Exit, Redacted } from "effect";
import { describe, expect, test } from "vitest";
import { CloudSecrets, cloudSecretsLayer, cloudSecretsLayerWithKey } from "../src/cloud-secrets.ts";

const key = Redacted.make("3f".repeat(32));
const adminUrl = Redacted.make("postgres://admin:private-password@database.example/board");
const run = <A, E>(effect: Effect.Effect<A, E, CloudSecrets>) =>
	effect.pipe(Effect.provide(cloudSecretsLayerWithKey(key)), Effect.runPromise);

describe("CloudSecrets", () => {
	test("encrypts unique envelopes and credentials and returns only redacted plaintext", async () => {
		await run(
			Effect.gen(function* () {
				const secrets = yield* CloudSecrets;
				const first = yield* secrets.prepare("board-a", adminUrl);
				const second = yield* secrets.prepare("board-a", adminUrl);
				expect(first).not.toBe(second);
				expect(first).not.toContain("private-password");
				const payload = yield* secrets.decrypt("board-a", first);
				const other = yield* secrets.decrypt("board-a", second);
				expect(Redacted.value(payload).adminUrl).toBe(Redacted.value(adminUrl));
				expect(Redacted.value(payload).bootPassword).toHaveLength(64);
				expect(Redacted.value(payload).bootPassword).not.toBe(Redacted.value(payload).appPassword);
				expect(Redacted.value(payload).bootPassword).not.toBe(Redacted.value(other).bootPassword);
				expect(JSON.stringify(payload)).not.toContain("private-password");
				expect(String(payload)).not.toContain(Redacted.value(payload).appPassword);
			}),
		);
	});

	test("rejects swapped boards, version changes, tampering and wrong keys without disclosing secrets", async () => {
		const ciphertext = await run(
			Effect.gen(function* () {
				return yield* (yield* CloudSecrets).prepare("board-a", adminUrl);
			}),
		);
		for (const [boardId, envelope] of [
			["board-b", ciphertext],
			["board-a", ciphertext.replace("v1.", "v2.")],
			["board-a", `${ciphertext.slice(0, -8)}AAAAAAAA`],
			["board-a", "v1.bad.bad.bad"],
		]) {
			const exit = await run(
				Effect.gen(function* () {
					return yield* Effect.exit((yield* CloudSecrets).decrypt(boardId ?? "", envelope ?? ""));
				}),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(JSON.stringify(exit)).not.toContain("private-password");
		}
		const wrongKey = await Effect.gen(function* () {
			return yield* (yield* CloudSecrets).decrypt("board-a", ciphertext);
		}).pipe(Effect.provide(cloudSecretsLayerWithKey(Redacted.make("f3".repeat(32)))), Effect.runPromiseExit);
		expect(Exit.isFailure(wrongKey)).toBe(true);
	});

	test("uses stable key-dependent request fingerprints", async () => {
		const fingerprint = Effect.gen(function* () {
			return yield* (yield* CloudSecrets).fingerprint(adminUrl);
		});
		const first = await run(fingerprint);
		expect(await run(fingerprint)).toBe(first);
		const other = await fingerprint.pipe(
			Effect.provide(cloudSecretsLayerWithKey(Redacted.make("f3".repeat(32)))),
			Effect.runPromise,
		);
		expect(other).not.toBe(first);
	});

	test("disables missing configuration and rejects invalid keys without leaking their value", async () => {
		const missing = await Effect.gen(function* () {
			const secrets = yield* CloudSecrets;
			expect(secrets.enabled).toBe(false);
			return yield* Effect.exit(secrets.prepare("board-a", adminUrl));
		}).pipe(
			Effect.provide(cloudSecretsLayer),
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
			Effect.runPromise,
		);
		expect(Exit.isFailure(missing)).toBe(true);
		const invalid = await CloudSecrets.pipe(
			Effect.provide(cloudSecretsLayerWithKey(Redacted.make("private-invalid-key"))),
			Effect.runPromiseExit,
		);
		expect(Exit.isFailure(invalid)).toBe(true);
		expect(JSON.stringify(invalid)).not.toContain("private-invalid-key");
	});
});
