import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { importJWK } from "jose";

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", { setting: Schema.String }) {
	// Names the variable, never its value.
	override get message() {
		return `${this.setting} is missing or invalid`;
	}
}

/** Raw values as they arrive from the environment. Secrets stay redacted until they are parsed. */
export type RawSettings = {
	readonly issuer: string;
	readonly signingKey: Redacted.Redacted<string>;
	readonly sealKey: Redacted.Redacted<string>;
	readonly github: { readonly clientId: string; readonly clientSecret: Redacted.Redacted<string> };
	readonly google: { readonly clientId: string; readonly clientSecret: Redacted.Redacted<string> };
};

const base64url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
export const SigningJwk = Schema.Struct({
	kty: Schema.Literal("EC"),
	crv: Schema.Literal("P-256"),
	x: base64url,
	y: base64url,
	d: base64url,
	kid: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});

/** An origin with no path. http is accepted only on loopback, for local development and tests. */
const issuerOrigin = (value: string) => {
	const url = URL.parse(value);
	return (
		url !== null &&
		url.origin === value &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	);
};

/** Parse and check every setting once at startup, so a bad deployment fails before it serves. */
export const parse = (raw: RawSettings) =>
	Effect.gen(function* () {
		if (!issuerOrigin(raw.issuer)) return yield* new SettingsError({ setting: "SIGNIN_ISSUER" });
		const jwk = yield* Schema.decodeEffect(Schema.fromJsonString(SigningJwk))(Redacted.value(raw.signingKey)).pipe(
			Effect.mapError(() => new SettingsError({ setting: "SIGNIN_SIGNING_KEY" })),
		);
		const privateKey = yield* Effect.tryPromise({
			try: () => importJWK(jwk, "ES256"),
			catch: () => new SettingsError({ setting: "SIGNIN_SIGNING_KEY" }),
		});
		const sealHex = Redacted.value(raw.sealKey);
		if (!/^[0-9a-f]{64}$/i.test(sealHex)) return yield* new SettingsError({ setting: "SIGNIN_SEAL_KEY" });
		for (const [provider, prefix] of [
			[raw.github, "GITHUB"],
			[raw.google, "GOOGLE"],
		] as const) {
			if (provider.clientId === "") return yield* new SettingsError({ setting: `${prefix}_CLIENT_ID` });
			if (Redacted.value(provider.clientSecret) === "")
				return yield* new SettingsError({ setting: `${prefix}_CLIENT_SECRET` });
		}
		return {
			issuer: raw.issuer,
			signing: {
				kid: jwk.kid,
				privateKey,
				publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, alg: "ES256", use: "sig" },
			},
			sealKey: Redacted.make(Buffer.from(sealHex, "hex")),
			github: raw.github,
			google: raw.google,
		} as const;
	});

export class Settings extends Context.Service<Settings, Effect.Success<ReturnType<typeof parse>>>()(
	"comms/signin/Settings",
) {}

export const fromRaw = (raw: RawSettings) => Layer.effect(Settings, parse(raw));

export const layer = Layer.effect(
	Settings,
	Effect.gen(function* () {
		return yield* parse({
			issuer: yield* Config.String("SIGNIN_ISSUER"),
			signingKey: yield* Config.Redacted("SIGNIN_SIGNING_KEY"),
			sealKey: yield* Config.Redacted("SIGNIN_SEAL_KEY"),
			github: {
				clientId: yield* Config.String("GITHUB_CLIENT_ID"),
				clientSecret: yield* Config.Redacted("GITHUB_CLIENT_SECRET"),
			},
			google: {
				clientId: yield* Config.String("GOOGLE_CLIENT_ID"),
				clientSecret: yield* Config.Redacted("GOOGLE_CLIENT_SECRET"),
			},
		});
	}),
);
