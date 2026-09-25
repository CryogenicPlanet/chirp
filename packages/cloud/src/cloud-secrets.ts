import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { Config, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

const BootstrapPayload = Schema.Struct({
	adminUrl: Schema.String,
	bootPassword: Schema.String,
	appPassword: Schema.String,
});
const RuntimePayload = Schema.Struct({
	bootUrl: Schema.String,
	appUrl: Schema.String,
	tls: Schema.Boolean,
});
export type PostgresBootstrapSecretPayload = typeof BootstrapPayload.Type;
export type PostgresRuntimeSecretPayload = typeof RuntimePayload.Type;

export class CloudSecretsError extends Data.TaggedError("CloudSecretsError")<{
	readonly reason: "disabled" | "configuration" | "encrypt" | "decrypt" | "fingerprint";
}> {}

const make = (configuredKey?: Redacted.Redacted<string>) =>
	Effect.gen(function* () {
		if (configuredKey && !/^[a-fA-F0-9]{64}$/.test(Redacted.value(configuredKey)))
			return yield* new CloudSecretsError({ reason: "configuration" });
		// The key belongs to this scoped service instance, never to module state.
		const key = configuredKey ? Redacted.make(Buffer.from(Redacted.value(configuredKey), "hex")) : undefined;
		const keyId = key ? createHash("sha256").update(Redacted.value(key)).digest("base64url").slice(0, 22) : undefined;
		const requireKey = () => (key ? Effect.succeed(key) : Effect.fail(new CloudSecretsError({ reason: "disabled" })));
		const aad = (boardId: string, purpose: "bootstrap" | "runtime") =>
			Buffer.from(JSON.stringify(["chirp-cloud-postgres", 1, purpose, boardId]));
		const legacyAad = (boardId: string) => Buffer.from(JSON.stringify(["chirp-cloud-postgres", 1, boardId]));
		const encrypt = (boardId: string, purpose: "bootstrap" | "runtime", plaintext: string) =>
			Effect.gen(function* () {
				const encryptionKey = yield* requireKey();
				return yield* Effect.try({
					try: () => {
						const nonce = randomBytes(12);
						const cipher = createCipheriv("aes-256-gcm", Redacted.value(encryptionKey), nonce);
						cipher.setAAD(aad(boardId, purpose));
						const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
						return [
							"v1",
							keyId,
							nonce.toString("base64url"),
							cipher.getAuthTag().toString("base64url"),
							encrypted.toString("base64url"),
						].join(".");
					},
					catch: () => new CloudSecretsError({ reason: "encrypt" }),
				});
			});
		const decrypt = (boardId: string, purpose: "bootstrap" | "runtime", ciphertext: string) =>
			Effect.gen(function* () {
				const encryptionKey = yield* requireKey();
				return yield* Effect.try({
					try: () => {
						const parts = ciphertext.split(".");
						const [version, first, second, third, fourth] = parts;
						if (version !== "v1") throw new Error("Invalid encrypted envelope");
						const identified = parts.length === 5;
						const envelopeKeyId = identified ? first : undefined;
						const nonceText = identified ? second : first;
						const tagText = identified ? third : second;
						const bodyText = identified ? fourth : third;
						if (
							(parts.length !== 4 && !identified) ||
							(identified && (!envelopeKeyId || envelopeKeyId !== keyId)) ||
							!nonceText ||
							!tagText ||
							!bodyText
						)
							throw new Error("Invalid encrypted envelope");
						if (
							![...(envelopeKeyId ? [envelopeKeyId] : []), nonceText, tagText, bodyText].every((part) =>
								/^[A-Za-z0-9_-]+$/.test(part),
							)
						)
							throw new Error("Invalid encrypted encoding");
						const nonce = Buffer.from(nonceText, "base64url");
						const tag = Buffer.from(tagText, "base64url");
						if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted lengths");
						const open = (associatedData: Buffer) => {
							const decipher = createDecipheriv("aes-256-gcm", Redacted.value(encryptionKey), nonce);
							decipher.setAAD(associatedData);
							decipher.setAuthTag(tag);
							return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString(
								"utf8",
							);
						};
						if (identified || purpose === "runtime") return open(aad(boardId, purpose));
						try {
							return open(aad(boardId, purpose));
						} catch {
							return open(legacyAad(boardId));
						}
					},
					catch: () => new CloudSecretsError({ reason: "decrypt" }),
				});
			});
		return {
			enabled: key !== undefined,
			prepare: (boardId: string, adminUrl: Redacted.Redacted<string>) =>
				Effect.gen(function* () {
					const payload: PostgresBootstrapSecretPayload = {
						adminUrl: Redacted.value(adminUrl),
						bootPassword: randomBytes(32).toString("hex"),
						appPassword: randomBytes(32).toString("hex"),
					};
					return yield* encrypt(
						boardId,
						"bootstrap",
						Schema.encodeSync(Schema.fromJsonString(BootstrapPayload))(payload),
					);
				}),
			prepareRuntime: (boardId: string, payload: PostgresRuntimeSecretPayload) =>
				encrypt(boardId, "runtime", Schema.encodeSync(Schema.fromJsonString(RuntimePayload))(payload)),
			decryptBootstrap: (boardId: string, ciphertext: string) =>
				decrypt(boardId, "bootstrap", ciphertext).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BootstrapPayload))),
					Effect.map(Redacted.make),
					Effect.mapError(() => new CloudSecretsError({ reason: "decrypt" })),
				),
			decryptRuntime: (boardId: string, ciphertext: string) =>
				decrypt(boardId, "runtime", ciphertext).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimePayload))),
					Effect.map(Redacted.make),
					Effect.mapError(() => new CloudSecretsError({ reason: "decrypt" })),
				),
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
