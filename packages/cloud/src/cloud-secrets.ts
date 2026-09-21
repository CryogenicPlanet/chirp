import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

const Payload = Schema.Struct({
	adminUrl: Schema.String,
	bootPassword: Schema.String,
	appPassword: Schema.String,
});
export type PostgresSecretPayload = typeof Payload.Type;

export class CloudSecretsError extends Data.TaggedError("CloudSecretsError")<{
	readonly reason: "disabled" | "configuration" | "encrypt" | "decrypt" | "fingerprint";
}> {}

const make = (configuredKey?: Redacted.Redacted<string>) =>
	Effect.gen(function* () {
		if (configuredKey && !/^[a-fA-F0-9]{64}$/.test(Redacted.value(configuredKey)))
			return yield* new CloudSecretsError({ reason: "configuration" });
		// The key belongs to this scoped service instance, never to module state.
		const key = configuredKey ? Redacted.make(Buffer.from(Redacted.value(configuredKey), "hex")) : undefined;
		const requireKey = () => (key ? Effect.succeed(key) : Effect.fail(new CloudSecretsError({ reason: "disabled" })));
		const aad = (boardId: string) => Buffer.from(JSON.stringify(["chirp-cloud-postgres", 1, boardId]));
		return {
			enabled: key !== undefined,
			prepare: (boardId: string, adminUrl: Redacted.Redacted<string>) =>
				Effect.gen(function* () {
					const encryptionKey = yield* requireKey();
					// Node crypto supplies authenticated encryption, which Effect Crypto does not expose.
					return yield* Effect.try({
						try: () => {
							const nonce = randomBytes(12);
							const cipher = createCipheriv("aes-256-gcm", Redacted.value(encryptionKey), nonce);
							cipher.setAAD(aad(boardId));
							const payload: PostgresSecretPayload = {
								adminUrl: Redacted.value(adminUrl),
								bootPassword: randomBytes(32).toString("hex"),
								appPassword: randomBytes(32).toString("hex"),
							};
							const encrypted = Buffer.concat([
								cipher.update(Schema.encodeSync(Schema.fromJsonString(Payload))(payload), "utf8"),
								cipher.final(),
							]);
							return [
								"v1",
								nonce.toString("base64url"),
								cipher.getAuthTag().toString("base64url"),
								encrypted.toString("base64url"),
							].join(".");
						},
						catch: () => new CloudSecretsError({ reason: "encrypt" }),
					});
				}),
			decrypt: (boardId: string, ciphertext: string) =>
				Effect.gen(function* () {
					const encryptionKey = yield* requireKey();
					const decoded = yield* Effect.try({
						try: (): unknown => {
							const parts = ciphertext.split(".");
							const [version, nonceText, tagText, bodyText] = parts;
							if (parts.length !== 4 || version !== "v1" || !nonceText || !tagText || !bodyText)
								throw new Error("Invalid encrypted envelope");
							if (![nonceText, tagText, bodyText].every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
								throw new Error("Invalid encrypted encoding");
							const nonce = Buffer.from(nonceText, "base64url");
							const tag = Buffer.from(tagText, "base64url");
							if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted lengths");
							const decipher = createDecipheriv("aes-256-gcm", Redacted.value(encryptionKey), nonce);
							decipher.setAAD(aad(boardId));
							decipher.setAuthTag(tag);
							return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString(
								"utf8",
							);
						},
						catch: () => new CloudSecretsError({ reason: "decrypt" }),
					});
					return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))(decoded).pipe(
						Effect.map(Redacted.make),
						Effect.mapError(() => new CloudSecretsError({ reason: "decrypt" })),
					);
				}),
			fingerprint: (adminUrl: Redacted.Redacted<string>) =>
				Effect.gen(function* () {
					const encryptionKey = yield* requireKey();
					return yield* Effect.try({
						try: () =>
							createHmac("sha256", Redacted.value(encryptionKey))
								.update("chirp-cloud-postgres-request-v1\0")
								.update(Redacted.value(adminUrl))
								.digest("hex"),
						catch: () => new CloudSecretsError({ reason: "fingerprint" }),
					});
				}),
		};
	});

export class CloudSecrets extends Context.Service<CloudSecrets, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/CloudSecrets",
) {}
export const cloudSecretsLayerWithKey = (key?: Redacted.Redacted<string>) => Layer.effect(CloudSecrets, make(key));
export const cloudSecretsLayer = Layer.effect(
	CloudSecrets,
	Config.option(Config.Redacted("CLOUD_SECRETS_KEY")).pipe(Effect.flatMap((key) => make(Option.getOrUndefined(key)))),
);
