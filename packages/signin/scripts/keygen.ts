import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Crypto, Effect, Schema } from "effect";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { SigningJwk } from "../src/settings.ts";

/**
 * Print a fresh SIGNIN_SIGNING_KEY (ES256 private JWK, kid = RFC 7638 thumbprint) and SIGNIN_SEAL_KEY
 * (32 random bytes as hex) as NAME=VALUE lines. Pipe straight into `fly secrets import`; never commit the output.
 */
const keygen = Effect.gen(function* () {
	const { privateKey } = yield* Effect.tryPromise(() => generateKeyPair("ES256", { extractable: true }));
	const jwk = yield* Effect.tryPromise(() => exportJWK(privateKey));
	const kid = yield* Effect.tryPromise(() => calculateJwkThumbprint(jwk));
	const seal = yield* (yield* Crypto.Crypto).randomBytes(32);
	// Encoding through the schema Settings parses guarantees the printed key is one the service accepts.
	const encoded = yield* Schema.decodeUnknownEffect(SigningJwk)({ ...jwk, kid }).pipe(
		Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(SigningJwk))),
	);
	yield* Console.log(`SIGNIN_SIGNING_KEY=${encoded}`);
	yield* Console.log(`SIGNIN_SEAL_KEY=${Buffer.from(seal).toString("hex")}`);
});

keygen.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
