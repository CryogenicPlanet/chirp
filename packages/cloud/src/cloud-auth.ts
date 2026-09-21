import { passkey } from "@better-auth/passkey";
import { betterAuth, getCurrentAdapter } from "better-auth";
import { getOAuthState } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { Context, Crypto, Data, DateTime, Effect, Layer, Redacted } from "effect";
import { Pool, types as pgTypes } from "pg";
import { authSchema } from "./auth-schema.ts";
import type { CloudAuthSettings } from "./auth-settings.ts";
import { hasAuthoritativeClientIp } from "./client-ip-boundary.ts";
import { checkInvitation, InvitationPolicyError } from "./invitation-policy.ts";
import { invitationPlugin } from "./invitation-plugin.ts";

export class CloudAuthError extends Data.TaggedError("CloudAuthError")<{
	readonly cause: unknown;
}> {}

const hex = (bytes: Uint8Array) => {
	let encoded = "";
	for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
	return encoded;
};

const hostOnlyCookieAttributes = {
	secure: true,
	httpOnly: true,
	sameSite: "lax",
	path: "/",
} as const;

const make = (settings: CloudAuthSettings) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const context = yield* Effect.context<Crypto.Crypto>();
		const runPromise = Effect.runPromiseWith(context);
		const runFork = Effect.runForkWith(context);
		const onPoolError = () => {
			runFork(Effect.logError("Chirp Cloud authentication lost an idle PostgreSQL connection"));
		};
		const pool = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const pool = new Pool({
					connectionString: Redacted.value(settings.databaseUrl),
					application_name: "chirp-cloud-auth",
					max: 8,
					types: {
						getTypeParser: (oid, format) =>
							oid === 20 ? (value: string) => Number(value) : pgTypes.getTypeParser(oid, format),
					},
				});
				pool.on("error", onPoolError);
				return pool;
			}),
			(pool) =>
				Effect.promise(() => pool.end()).pipe(
					Effect.tap(() => Effect.logInfo("Chirp Cloud authentication pool stopped")),
					Effect.ensuring(Effect.sync(() => pool.removeListener("error", onPoolError))),
					Effect.orDie,
				),
		);
		const database = drizzle({ client: pool });
		const auth = betterAuth({
			appName: "Chirp Cloud",
			baseURL: settings.publicOrigin,
			secret: Redacted.value(settings.authSecret),
			database: drizzleAdapter(database, {
				provider: "pg",
				schema: authSchema,
				transaction: true,
			}),
			trustedOrigins: [settings.publicOrigin],
			advanced: {
				disableOriginCheck: false,
				disableCSRFCheck: false,
				useSecureCookies: false,
				defaultCookieAttributes: { secure: true },
				ipAddress: { ipAddressHeaders: [settings.clientIpHeader] },
				cookies: {
					session_token: {
						name: "__Host-chirp-cloud.session_token",
						attributes: hostOnlyCookieAttributes,
					},
					oauth_state: {
						name: "__Host-chirp-cloud.oauth_state",
						attributes: hostOnlyCookieAttributes,
					},
					dont_remember: {
						name: "__Host-chirp-cloud.dont_remember",
						attributes: hostOnlyCookieAttributes,
					},
					"better-auth-passkey": {
						name: "__Host-chirp-cloud.passkey_challenge",
						attributes: hostOnlyCookieAttributes,
					},
				},
			},
			rateLimit: { enabled: true, storage: "database" },
			socialProviders: {
				github: {
					clientId: settings.githubClientId,
					clientSecret: Redacted.value(settings.githubClientSecret),
					disableImplicitSignUp: true,
					requireEmailVerification: true,
				},
				google: {
					clientId: settings.googleClientId,
					clientSecret: Redacted.value(settings.googleClientSecret),
					disableImplicitSignUp: true,
					requireEmailVerification: true,
				},
			},
			account: {
				encryptOAuthTokens: true,
				storeStateStrategy: "cookie",
				accountLinking: { disableImplicitLinking: true },
			},
			user: {
				validateUserInfo: (identity, context) =>
					runPromise(
						checkInvitation(identity, {
							readToken: Effect.tryPromise({
								try: () => getOAuthState<{ invitation?: unknown }>(),
								catch: (cause) => new InvitationPolicyError({ cause }),
							}).pipe(Effect.map((state) => state?.invitation)),
							digest: (token) =>
								crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
									Effect.map(hex),
									Effect.mapError((cause) => new InvitationPolicyError({ cause })),
								),
							now: DateTime.nowAsDate,
							consume: ({ tokenDigest, email, after }) =>
								Effect.tryPromise({
									try: () =>
										getCurrentAdapter(context.context.adapter).then((adapter) =>
											adapter.consumeOne({
												model: "cloudInvitation",
												where: [
													{ field: "tokenDigest", value: tokenDigest },
													{ field: "email", value: email, mode: "insensitive" },
													{ field: "expiresAt", value: after, operator: "gt" },
												],
											}),
										),
									catch: (cause) => new InvitationPolicyError({ cause }),
								}).pipe(Effect.map((invitation) => invitation !== null)),
						}),
					),
			},
			plugins: [
				invitationPlugin,
				passkey({
					rpID: new URL(settings.publicOrigin).hostname,
					rpName: "Chirp Cloud",
					origin: settings.publicOrigin,
				}),
			],
		});
		return {
			handle: (request: Request) =>
				hasAuthoritativeClientIp(request.headers, settings.clientIpHeader)
					? Effect.tryPromise({
							try: () => auth.handler(request),
							catch: (cause) => new CloudAuthError({ cause }),
						})
					: Effect.succeed(Response.json({ error: "invalid_client_ip" }, { status: 503 })),
			getSession: (headers: Headers) =>
				Effect.tryPromise({
					try: () => auth.api.getSession({ headers }),
					catch: (cause) => new CloudAuthError({ cause }),
				}),
		};
	});

export class CloudAuth extends Context.Service<CloudAuth, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/CloudAuth",
) {}
export const cloudAuthLayer = (settings: CloudAuthSettings) => Layer.effect(CloudAuth, make(settings));
