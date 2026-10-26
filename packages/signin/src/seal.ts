// Effect Crypto exposes random bytes and digests but no authenticated encryption or constant-time compare.
// This narrow adapter keeps native crypto and its failures inside Effect.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { Crypto, Effect, Redacted, Schema } from "effect";

export class SealError extends Schema.TaggedError<SealError>()("SealError", {}) {}

/**
 * The purpose is authenticated data, so a transaction cookie can never be redeemed as a code, a session cookie can
 * never be opened as either, and the reverse.
 */
type Purpose = "transaction" | "code" | "session";
const aad = (purpose: Purpose) => Buffer.from(`chirp-signin-${purpose}-v1`);
const nonceBytes = 12;
const tagBytes = 16;

/** AES-256-GCM over the JSON encoding, as base64url(nonce || ciphertext || tag). */
export const seal = <A, I>(key: Redacted.Redacted<Buffer>, purpose: Purpose, schema: Schema.Codec<A, I>, value: A) =>
	Effect.gen(function* () {
		const json = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(Effect.orDie);
		const nonce = yield* (yield* Crypto.Crypto).randomBytes(nonceBytes).pipe(Effect.orDie);
		const cipher = createCipheriv("aes-256-gcm", Redacted.value(key), nonce);
		cipher.setAAD(aad(purpose));
		const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
		return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
	});

/** Any malformed, tampered, foreign-purpose or wrongly shaped value is the same SealError. */
export const open = <A, I>(
	key: Redacted.Redacted<Buffer>,
	purpose: Purpose,
	schema: Schema.Codec<A, I>,
	sealed: string,
) =>
	Effect.gen(function* () {
		const bytes = Buffer.from(sealed, "base64url");
		if (
			sealed.length > 8192 ||
			!/^[A-Za-z0-9_-]+$/.test(sealed) ||
			bytes.toString("base64url") !== sealed ||
			bytes.length <= nonceBytes + tagBytes
		)
			return yield* new SealError();
		const json = yield* Effect.try({
			try: () => {
				const decipher = createDecipheriv("aes-256-gcm", Redacted.value(key), bytes.subarray(0, nonceBytes));
				decipher.setAAD(aad(purpose));
				decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
				return Buffer.concat([
					decipher.update(bytes.subarray(nonceBytes, bytes.length - tagBytes)),
					decipher.final(),
				]).toString("utf8");
			},
			catch: () => new SealError(),
		});
		return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(json, { onExcessProperty: "error" }).pipe(
			Effect.mapError(() => new SealError()),
		);
	});

/** A fresh base64url token of `size` random bytes. */
export const randomToken = (size: number) =>
	Effect.gen(function* () {
		const bytes = yield* (yield* Crypto.Crypto).randomBytes(size).pipe(Effect.orDie);
		return Buffer.from(bytes).toString("base64url");
	});

/** base64url(SHA-256(value)), the RFC 7636 S256 transform. */
export const s256 = (value: string) =>
	Effect.gen(function* () {
		const digest = yield* (yield* Crypto.Crypto).digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie);
		return Buffer.from(digest).toString("base64url");
	});

export const sameSecret = (left: string, right: string) => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};
