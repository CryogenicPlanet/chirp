import { randomBytes } from "node:crypto";
import { BunCrypto } from "@effect/platform-bun";
import { Effect, Redacted, Schema } from "effect";
import { expect, it } from "vitest";
import { open, type SealError, seal } from "../src/seal.ts";

const Value = Schema.Struct({ subject: Schema.String });
const key = () => Redacted.make(randomBytes(32));
const run = <A>(effect: Effect.Effect<A, SealError>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.map(String),
			Effect.catchTag("SealError", () => Effect.succeed("refused")),
		),
	);

it("opens only with the same key and purpose, and never reveals the plaintext", async () => {
	const first = key();
	const sealed = await Effect.runPromise(
		seal(first, "code", Value, { subject: "github:4242" }).pipe(Effect.provide(BunCrypto.layer)),
	);
	expect(sealed).not.toContain("4242");
	expect(Buffer.from(sealed, "base64url").toString("utf8")).not.toContain("github");
	const opened = open(first, "code", Value, sealed).pipe(Effect.map((value) => value.subject));
	expect(await run(opened)).toBe("github:4242");
	expect(await run(open(key(), "code", Value, sealed))).toBe("refused");
	expect(await run(open(first, "transaction", Value, sealed))).toBe("refused");
	expect(await run(open(first, "code", Schema.Struct({ other: Schema.String }), sealed))).toBe("refused");
	expect(await run(open(first, "code", Value, `${sealed}=`))).toBe("refused");
});
