import { Config, Data, Effect, Redacted } from "effect";

export type OAuthProvider = "github" | "google";

interface OAuthCredentials {
	readonly clientId: string;
	readonly clientSecret: Redacted.Redacted;
}

export interface CloudAuthSettings {
	readonly databaseUrl: Redacted.Redacted;
	readonly publicOrigin: string;
	readonly authSecret: Redacted.Redacted;
	readonly clientIpHeader: string;
	readonly github: OAuthCredentials | undefined;
	readonly google: OAuthCredentials | undefined;
}

export class AuthConfigurationError extends Data.TaggedError("AuthConfigurationError")<{
	readonly message: string;
}> {}

export const cloudAuthSettings = Effect.gen(function* () {
	const values = yield* Config.all({
		databaseUrl: Config.Redacted("CLOUD_DATABASE_URL"),
		publicUrl: Config.URL("BETTER_AUTH_URL"),
		authSecret: Config.Redacted("BETTER_AUTH_SECRET"),
		clientIpHeader: Config.String("CLOUD_CLIENT_IP_HEADER"),
		githubClientId: Config.String("GITHUB_CLIENT_ID").pipe(Config.withDefault("")),
		githubClientSecret: Config.Redacted("GITHUB_CLIENT_SECRET").pipe(Config.withDefault(Redacted.make(""))),
		googleClientId: Config.String("GOOGLE_CLIENT_ID").pipe(Config.withDefault("")),
		googleClientSecret: Config.Redacted("GOOGLE_CLIENT_SECRET").pipe(Config.withDefault(Redacted.make(""))),
	});
	if (values.publicUrl.pathname !== "/" || values.publicUrl.search || values.publicUrl.hash)
		return yield* new AuthConfigurationError({ message: "BETTER_AUTH_URL must be an origin without a path" });
	if (
		values.publicUrl.protocol !== "https:" &&
		values.publicUrl.hostname !== "localhost" &&
		values.publicUrl.hostname !== "127.0.0.1"
	)
		return yield* new AuthConfigurationError({ message: "BETTER_AUTH_URL must use HTTPS outside local development" });
	if (!/^postgres(?:ql)?:\/\//.test(Redacted.value(values.databaseUrl)))
		return yield* new AuthConfigurationError({ message: "CLOUD_DATABASE_URL must use PostgreSQL" });
	const authSecret = Redacted.value(values.authSecret);
	if (authSecret.length < 32 || new Set(authSecret).size < 12)
		return yield* new AuthConfigurationError({
			message: "BETTER_AUTH_SECRET must be a high-entropy secret with at least 32 characters",
		});
	const clientIpHeader = values.clientIpHeader.trim().toLowerCase();
	if (!/^[a-z0-9-]+$/.test(clientIpHeader))
		return yield* new AuthConfigurationError({ message: "CLOUD_CLIENT_IP_HEADER must be one HTTP header name" });
	const credentials = (provider: OAuthProvider, clientId: string, clientSecret: Redacted.Redacted) =>
		Effect.gen(function* () {
			const hasId = clientId.trim().length > 0;
			const hasSecret = Redacted.value(clientSecret).trim().length > 0;
			if (hasId !== hasSecret)
				return yield* new AuthConfigurationError({ message: `${provider} requires both client ID and client secret` });
			return hasId ? { clientId, clientSecret } : undefined;
		});
	const github = yield* credentials("github", values.githubClientId, values.githubClientSecret);
	const google = yield* credentials("google", values.googleClientId, values.googleClientSecret);
	if (!github && !google)
		return yield* new AuthConfigurationError({ message: "At least one OAuth provider must be configured" });
	return {
		databaseUrl: values.databaseUrl,
		publicOrigin: values.publicUrl.origin,
		authSecret: values.authSecret,
		clientIpHeader,
		github,
		google,
	} satisfies CloudAuthSettings;
});
