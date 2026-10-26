import { Clock, Duration, Effect, Schema } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { open, s256, seal } from "./seal.ts";
import { Settings } from "./settings.ts";
import { Identity, type Provider, providers } from "./upstream.ts";

const sessionLifetime = Duration.days(30);
const maxConsents = 64;

/**
 * A provider's remembered sign-in: the account, when it last signed in upstream, and the boards it consented to,
 * newest first. The session ends 30 days after that upstream sign-in, however often it is used.
 */
const Session = Schema.Struct({
	identity: Identity,
	auth_time: Schema.Int,
	consented: Schema.Array(Schema.String).check(Schema.isMaxLength(maxConsents)),
	exp: Schema.Int,
});
type Session = typeof Session.Type;

// __Host- cookies need Secure and Path=/ and no Domain, including when they are expired. SameSite=Lax, not Strict,
// so the cookies ride the top-level GET a board on another site sends to /authorize.
export const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

/** Exactly one cookie of this name; a duplicate means another cookie was planted beside ours. */
export const readCookie = (request: HttpServerRequest.HttpServerRequest, name: string) => {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
};

// One cookie per provider, so signing in with GitHub never replaces the consents remembered for Google.
const sessionCookie = (provider: Provider) => `__Host-signin.${provider}`;

/** The provider's live session. A missing, duplicated, tampered, foreign or expired cookie is no session, never an error. */
export const readSession = (request: HttpServerRequest.HttpServerRequest, provider: Provider) =>
	Effect.gen(function* () {
		const sealed = readCookie(request, sessionCookie(provider));
		if (sealed === undefined) return undefined;
		const settings = yield* Settings;
		const session = yield* open(settings.sealKey, "session", Session, sealed).pipe(
			Effect.orElseSucceed(() => undefined),
		);
		if (session === undefined || session.identity.provider !== provider) return undefined;
		return session.exp > (yield* Clock.currentTimeMillis) ? session : undefined;
	});

/** 128 bits of S256(client_id, redirect origin), so a client document that adds an origin is asked again. */
export const consentKey = (clientId: string, redirectOrigin: string) =>
	s256(`${clientId} ${redirectOrigin}`).pipe(Effect.map((digest) => digest.slice(0, 22)));

/**
 * The cookie that remembers a consent. The same account keeps its list with this key moved to the front, dropping
 * the oldest past 64; another account starts a new list. The session lasts 30 days from `authTime`, never longer.
 */
export const rememberConsent = (previous: Session | undefined, identity: Identity, authTime: number, key: string) =>
	Effect.gen(function* () {
		const settings = yield* Settings;
		const name = sessionCookie(identity.provider);
		const exp = authTime * 1000 + Duration.toMillis(sessionLifetime);
		const remaining = exp - (yield* Clock.currentTimeMillis);
		if (remaining <= 0) return HttpServerResponse.expireCookieUnsafe(name, cookieOptions);
		const kept = previous?.identity.sub === identity.sub ? previous.consented.filter((other) => other !== key) : [];
		const sealed = yield* seal(settings.sealKey, "session", Session, {
			identity,
			auth_time: authTime,
			consented: [key, ...kept].slice(0, maxConsents),
			exp,
		});
		// A bare number for maxAge would be milliseconds.
		return HttpServerResponse.setCookieUnsafe(name, sealed, { ...cookieOptions, maxAge: Duration.millis(remaining) });
	});

/** Expire every provider's session cookie. */
export const forgetSessions = (response: HttpServerResponse.HttpServerResponse) =>
	providers.reduce(
		(current, provider) => HttpServerResponse.expireCookieUnsafe(current, sessionCookie(provider), cookieOptions),
		response,
	);
