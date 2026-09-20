import { Config, Data, Effect, Redacted } from "effect";

export interface CloudAuthSettings {
	readonly databaseUrl: Redacted.Redacted;
	readonly publicOrigin: string;
	readonly authSecret: Redacted.Redacted;
	readonly githubClientId: string;
	readonly githubClientSecret: Redacted.Redacted;
	readonly googleClientId: string;
	readonly googleClientSecret: Redacted.Redacted;
}

export class AuthConfigurationError extends Data.TaggedError("AuthConfigurationError")<{
	readonly message: string;
}> {}

export const cloudAuthSettings = Effect.gen(function* () {
	const values = yield* Config.all({
		databaseUrl: Config.Redacted("CLOUD_DATABASE_URL"),
		publicUrl: Config.URL("BETTER_AUTH_URL"),
		authSecret: Config.Redacted("BETTER_AUTH_SECRET"),
		githubClientId: Config.String("GITHUB_CLIENT_ID"),
		githubClientSecret: Config.Redacted("GITHUB_CLIENT_SECRET"),
		googleClientId: Config.String("GOOGLE_CLIENT_ID"),
		googleClientSecret: Config.Redacted("GOOGLE_CLIENT_SECRET"),
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
	if (Redacted.value(values.authSecret).length < 32)
		return yield* new AuthConfigurationError({ message: "BETTER_AUTH_SECRET must contain at least 32 characters" });
	if (
		!values.githubClientId.trim() ||
		!Redacted.value(values.githubClientSecret).trim() ||
		!values.googleClientId.trim() ||
		!Redacted.value(values.googleClientSecret).trim()
	)
		return yield* new AuthConfigurationError({ message: "OAuth provider credentials must not be empty" });
	return {
		databaseUrl: values.databaseUrl,
		publicOrigin: values.publicUrl.origin,
		authSecret: values.authSecret,
		githubClientId: values.githubClientId,
		githubClientSecret: values.githubClientSecret,
		googleClientId: values.googleClientId,
		googleClientSecret: values.googleClientSecret,
	} satisfies CloudAuthSettings;
});
