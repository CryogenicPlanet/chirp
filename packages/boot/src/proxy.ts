import {
	agentHeader,
	applicationBearerPattern,
	applicationCookiePrefix,
	applicationIngressPath,
	ingressTargetHeader,
	ingressChallengeHeader,
	authKindHeader,
	baseVersionHeader,
	headerLabel,
	headerPrefix,
	initHeader,
	initStaleHeader,
	initVersionHeader,
	instanceHeader,
	labelHeader,
	requestIdHeader,
	scopesHeader,
	tokenExpiresHeader,
	traceparentHeader,
} from "@comms/protocol/headers";
import { applicationCookies, isReservedIngressPath } from "./application-ingress.ts";
import { recoveryRoute } from "./recovery-http.ts";
import { settingsRoute } from "./settings-http.ts";
import { recoveryManifest } from "./route-discovery.ts";
import { buildRevision } from "./build-revision.ts";
import { restartRoute } from "./restart-http.ts";
import { databaseRestoreRoute } from "./database-restore-http.ts";
import { backupRoute } from "./backup-http.ts";
import { Clock, Crypto, Effect, Ref, Stream } from "effect";
import {
	Cookies,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { Auth, AuthError } from "./auth.ts";
import { authenticate, authErrorResponse, authFailure, authRoute, namesGrant, sessionCookie } from "./auth-http.ts";
import { grantChannel, grantPathAllowed, grantRoute } from "./grant-http.ts";
import { reachesAttempt } from "./internal-channel.ts";
import { editRoute } from "./edit-http.ts";
import { passkeyManagementRoute } from "./passkey-management-http.ts";
import { passkeyCodeRoute } from "./passkey-code-http.ts";
import { oidcCookie, oidcRoute } from "./oidc-http.ts";
import { accountRoute } from "./account-http.ts";
import { tokenMintRoute } from "./token-mint-http.ts";
import { tokenRoute } from "./token-http.ts";
import { enrollmentRoute } from "./enrollment-http.ts";
import { eventRoute } from "./event-http.ts";
import { BootHttp } from "./boot-http.ts";
import { Events } from "./events.ts";

const help = `chirp local development bootloader

GET /_boot/settings  Human-only revisioned storage percentages.
POST /_boot/settings  Change {revision,patch} with a fresh settings.change assertion; retain proof for exact retries.
GET /health        Bootloader liveness (independent of the child).
GET /_boot/recovery  Human source-recovery page, independent of the child.
GET /_boot/status  Child state, bounded stderr tail and passkey/origin diagnostics.
GET /_boot/generations  Persistent generation history (also /api/generations).
GET /_boot/db/backups  Human-only backup catalog.
POST /_boot/db/backup  Capture a consistent app backup (human or fs scope).
POST /_boot/db/restore  Human-only database restore with a fresh db.restore assertion.
POST /_boot/restart {}  Human session and fresh boot.restart assertion; exits for the external supervisor to restart.
POST /_boot/reset {}  Human-only source reset to image seed with a fresh app.reset assertion; data and pages stay current.
GET /_boot/events?limit=100  Read boot recovery events with read scope; optional since and wait=0..60.

Source snapshots and restart recovery are active. Child crashes retry their snapshot three times,
then try older known-good snapshots. Human passkey setup and login are available at /setup and /auth/login.
Private routes require a session or agent access token. POST /auth/enroll starts enrollment; approval uses a fresh passkey.
POST /auth/refresh rotates a refresh credential; retry with the same Idempotency-Key after a lost response.
GET /_boot/enrollments and /_boot/tokens list account metadata for the human session.
POST /_boot/tokens mints a pair with a human session and fresh token.mint assertion; keep the exact proof for retries.
GET /_boot/auth/passkeys lists keys; passkey.add and passkey.delete assertions authorize key changes.
POST /_boot/auth/passkey-code {origin?} with a passkey.code assertion issues a 10-minute one-time code; redeem it at /auth/passkey-code.
A code bound to a new origin activates that origin when redeemed there. GET/DELETE /_boot/auth/origins lists or removes runtime origins.
GitHub and Google sign-in goes through OIDC_ISSUER (auth.chirp.wiki by default): POST /_boot/auth/oidc/start, then /auth/oidc/callback.
GET /_boot/auth/identities lists linked accounts; linking and unlinking need identity.link and identity.unlink assertions.
A linked account only opens a session. It is not a recovery path: passkeys and REOPEN_SETUP are the way back in.
POST /_boot/tokens/:family/revoke requires a human session and fresh token.revoke passkey assertion.
Extension grants: the live app asks boot to hold access for an agent; the human approves at /approve/<id>, and boot
answers the app's calls naming that grant. Boot keeps the credential; revoke a grant like any token family.
POST /api/lock acquires the editor; GET/PUT/DELETE /api/fs/app/<path> reads or stages source.
Save ${headerLabel(baseVersionHeader)} from GET; PUT ?reload=0&baseVersion=<token> stages raw bytes.
Use baseVersion=null only for an absent file. POST /api/reload rehearses and cuts over. Failed edits retain the repair lock.
POST /api/reload?release=1 releases the lock after a successful edit.
POST /api/revert {} undoes the latest app batch; {path}, {batch}, or {version} selects retained source history.
POST /api/revert {generation:n} restores a retained whole source tree and rebuilds its locked dependencies.
Source-only revert needs your edit lock and empty staging; source must have complete retained provenance.
POST /api/revert {generation:n,withDb:true} restores source and its exact pre-flip backup with a fresh generation.restore assertion.
Local commands bind to 127.0.0.1 by default. The development image publishes only to host loopback.
If first startup fails, repair source through /api/fs/app/<path> and POST /api/reload, or fix DATA_DIR/app and restart the launcher.
After a healthy startup, restarts use the newest known-good snapshot even if the editable source is broken.
`;

const reserved: readonly string[] = Object.freeze([
	"/api/fs",
	"/api/lock",
	"/api/reload",
	"/api/revert",
	"/api/generations",
	"/api/tokens",
	"/auth",
	"/approve",
	"/setup",
]);
const hopHeaders: readonly string[] = Object.freeze([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export const proxy = Effect.gen(function* () {
	const { child, authConfig, editing, requests, backups, restores, captures, phase, restart, storeIdentity, ingress } =
		yield* BootHttp;
	const auth = yield* Auth;
	const events = yield* Events;
	const request = yield* HttpServerRequest.HttpServerRequest;
	const started = yield* Clock.monotonicTimeNanos;
	const url = new URL(request.url, "http://localhost");
	const path = url.pathname;
	const crypto = yield* Crypto.Crypto;
	const requestId = Buffer.from(yield* crypto.randomBytes(16)).toString("hex");
	// Polls and the child protocol must not manufacture events that wake themselves.
	const excluded =
		["/health", "/_boot/status", "/api/events", "/_boot/events", "/api/stream"].includes(path) ||
		path === "/_kernel" ||
		path.startsWith("/_kernel/") ||
		path.startsWith("/_boot/seq") ||
		path.startsWith("/_boot/events/") ||
		(path === "/_boot/db/backup" && request.headers["x-boot-secret"] !== undefined);
	const observed = excluded
		? null
		: yield* requests({
				started,
				method: request.method,
				path,
				search: url.search,
				userAgent: request.headers["user-agent"],
				identity: null,
				generation: 0,
				requestId,
			});
	const applicationBearer = applicationBearerPattern.test(request.headers.authorization ?? "");
	const boardSession = (request.headers.cookie ?? "")
		.split(";")
		.some((part) => part.trim().startsWith(`${sessionCookie}=`));
	const grant = namesGrant(request);
	/** Authenticates when required, then serves boot's edit and diagnostic routes or forwards to the live child. */
	/** grantEpoch is the live attempt a grant request was validated against; admission must still reach it. */
	const forward = (authenticated: boolean, managedIngress: boolean, grantEpoch?: string) =>
		authFailure(
			Effect.gen(function* () {
				let identity = authenticated || grant ? yield* authenticate(auth, request) : null;
				if (observed) yield* observed.attribute(identity, 0);
				// Boot's own edit, event and diagnostic routes run before admission, so a grant must still come from the
				// routed live attempt here too; a cutover since validation refuses instead of letting a retiring child act.
				if (grantEpoch !== undefined && !reachesAttempt(yield* Ref.get(child.traffic.route), grantEpoch))
					return authErrorResponse("board_busy");
				if (identity?.kind === "human" && !["GET", "HEAD", "OPTIONS"].includes(request.method))
					yield* auth.relyingParty(request.headers.origin);
				const expires = (response: HttpServerResponse.HttpServerResponse) =>
					identity ? HttpServerResponse.setHeader(response, tokenExpiresHeader, String(identity.expiresAt)) : response;
				if (identity) {
					const edited = yield* editRoute(
						{ ...editing, writable: (yield* Ref.get(phase))._tag === "Ready" },
						auth,
						identity,
						restores,
					);
					if (edited) return expires(edited);
				}
				const eventResponse = yield* eventRoute(
					events,
					child.attempts,
					identity,
					child.channelGate,
					child.traffic.route,
					authenticate(auth, request).pipe(
						Effect.map((current) => current.scopes.includes("read")),
						Effect.orElseSucceed(() => false),
					),
				);
				if (eventResponse) return expires(eventResponse);
				if (
					["/_boot/status", "/_boot/generations", "/api/generations"].includes(path) &&
					identity?.kind !== "human" &&
					!identity?.scopes.includes("fs")
				)
					return yield* new AuthError({ code: "scope_required" });

				let destination = yield* Ref.get(child.traffic.route);
				const state = yield* Ref.get(child.status);
				const safeState = {
					...state,
					error: state.error === null ? null : child.redact(state.error),
					stderr: child.redact(state.stderr),
				};
				const generations = yield* Ref.get(child.generations);
				const lastGood = generations.find((generation) => generation.good === 1)?.n ?? null;
				if (path === "/_boot/status" && request.method === "GET") {
					return expires(
						HttpServerResponse.jsonUnsafe({
							revision: yield* buildRevision,
							ingress: ingress ?? { applicationManagedIngress: false, error: null },
							authenticated: true,
							child: safeState,
							source_recovery_error: yield* Ref.get(child.sourceError).pipe(
								Effect.map((error) => (error === null ? null : child.redact(error))),
							),
							store_identity: storeIdentity
								? yield* Effect.gen(function* () {
										return yield* storeIdentity;
									}).pipe(Effect.orElseSucceed(() => null))
								: null,
							traffic: yield* child.traffic.state,
							passkey_origins: yield* auth.passkeyOriginState.pipe(Effect.orElseSucceed(() => null)),
							last_good: lastGood,
						}),
					);
				}
				if ((path === "/_boot/generations" || path === "/api/generations") && request.method === "GET") {
					return expires(
						HttpServerResponse.jsonUnsafe({
							items: generations.map((generation) => ({
								...generation,
								error: generation.error === null ? null : child.redact(generation.error),
								stderr: generation.stderr === null ? null : child.redact(generation.stderr),
							})),
							last_good: lastGood,
						}),
					);
				}
				if (
					path === "/_boot" ||
					path.startsWith("/_boot/") ||
					reserved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
				) {
					return expires(
						HttpServerResponse.jsonUnsafe(
							{
								error: {
									code: "not_implemented",
									message: "This boot route is not implemented.",
									hint: "GET /_boot lists available routes.",
									retriable: false,
								},
							},
							{ status: 501 },
						),
					);
				}
				const unavailable = () =>
					HttpServerResponse.jsonUnsafe(
						{
							error: {
								code: "app_unavailable",
								message: "The server child is unavailable.",
								hint: "GET /_boot/status and /_boot/generations for diagnostics. Open /_boot/recovery for human source undo. GET /_boot explains local recovery.",
								retriable: true,
							},
							...(identity?.kind === "human" || identity?.scopes.includes("fs")
								? { child: safeState, last_good: lastGood }
								: {}),
						},
						{ status: 503 },
					);
				if (grant) {
					// Grant requests are admitted without waiting; a freeze that began after the gate still refuses.
					const admitted = yield* child.traffic.requests.admitNow;
					if (!admitted) return authErrorResponse("board_busy");
					destination = admitted.destination;
					if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
						const mutation = yield* child.traffic.admitNow;
						if (!mutation) return authErrorResponse("board_busy");
						destination = mutation.destination;
					}
					// A cutover between validation and admission can switch the route to an accepted candidate; a grant
					// only ever reaches the live generation whose attempt it was validated against.
					if (grantEpoch === undefined || !reachesAttempt(destination, grantEpoch))
						return authErrorResponse("board_busy");
				} else {
					const requestAdmission = yield* child.traffic.requests.awaitDestination.pipe(Effect.result);
					if (requestAdmission._tag === "Failure") return expires(unavailable());
					if (requestAdmission.success.waited && identity) identity = yield* authenticate(auth, request);
					destination = requestAdmission.success.destination;
					if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
						const admitted = yield* child.traffic.awaitDestination;
						destination = admitted.destination;
						if (admitted.waited && identity) identity = yield* authenticate(auth, request);
					}
				}
				if (!destination) return expires(unavailable());
				if (managedIngress && !destination.applicationManagedIngress)
					return applicationBearer
						? authErrorResponse("credential_required", 401)
						: yield* new AuthError({ code: "session_invalid" });
				const connectionHeaders = new Set(
					(request.headers.connection ?? "")
						.toLowerCase()
						.split(",")
						.map((name) => name.trim()),
				);
				const headers = Object.fromEntries(
					Object.entries(request.headers).filter(
						([name]) =>
							!hopHeaders.includes(name) &&
							!connectionHeaders.has(name) &&
							!name.startsWith(headerPrefix) &&
							!name.startsWith("x-forwarded-") &&
							![
								"host",
								"authorization",
								"cookie",
								"x-boot-secret",
								"forwarded",
								"content-length",
								"traceparent",
								"tracestate",
								"baggage",
							].includes(name),
					),
				);
				if (observed) yield* observed.attribute(identity, destination.generation);
				let outgoing = HttpClientRequest.make(request.method)(
					`http://127.0.0.1:${destination.port}${managedIngress ? applicationIngressPath : path + url.search}`,
					{
						headers: {
							...headers,
							...(request.headers[initHeader] && /^[a-f0-9]{64}$/.test(request.headers[initHeader])
								? { [initHeader]: request.headers[initHeader] }
								: {}),
							...(managedIngress ? { [ingressTargetHeader]: path + url.search } : {}),
							...(managedIngress && applicationBearer && !connectionHeaders.has("authorization")
								? { authorization: request.headers.authorization }
								: {}),
							...(ingress?.applicationManagedIngress &&
							!connectionHeaders.has("cookie") &&
							applicationCookies(request.headers.cookie)
								? { cookie: applicationCookies(request.headers.cookie) }
								: {}),
							"x-boot-secret": destination.secret,
							[requestIdHeader]: requestId,
							...(observed ? { [traceparentHeader]: observed.trace } : {}),
							...(identity
								? {
										[agentHeader]: identity.agent,
										[authKindHeader]: identity.kind,
										[instanceHeader]: identity.id,
										[scopesHeader]: identity.scopes.join(","),
										[labelHeader]: identity.label,
										[tokenExpiresHeader]: String(identity.expiresAt),
									}
								: {}),
						},
					},
				);
				if (
					request.method !== "GET" &&
					request.method !== "HEAD" &&
					((request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
						request.headers["transfer-encoding"] !== undefined)
				)
					outgoing = outgoing.pipe(
						HttpClientRequest.bodyStream(request.stream, { contentType: headers["content-type"] ?? "" }),
					);
				const client = yield* HttpClient.HttpClient;

				return yield* client.execute(outgoing).pipe(
					Effect.flatMap((response) =>
						Effect.gen(function* () {
							if (
								managedIngress &&
								!applicationBearer &&
								response.status === 401 &&
								response.headers[ingressChallengeHeader] === "credential_required"
							)
								return yield* authFailure(Effect.fail(new AuthError({ code: "session_invalid" })));
							const connection = new Set(
								(response.headers.connection ?? "")
									.toLowerCase()
									.split(",")
									.map((name) => name.trim()),
							);
							const converted = HttpServerResponse.fromClientResponse(response);
							const responseHeaders = Object.fromEntries(
								Object.entries(response.headers).filter(
									([name]) =>
										!hopHeaders.includes(name) &&
										!connection.has(name) &&
										name !== "x-boot-secret" &&
										(!name.startsWith(headerPrefix) || [initVersionHeader, initStaleHeader].includes(name)) &&
										name !== "set-cookie",
								),
							);
							if (converted.body._tag !== "Stream")
								return HttpServerResponse.empty({ status: response.status, headers: responseHeaders });
							let body = converted.body.stream;
							const credential = identity;
							if (
								credential &&
								(path === "/api/events" ||
									responseHeaders["content-type"]?.split(";")[0]?.trim() === "text/event-stream")
							) {
								// Authentication remains at the credential boundary even when the app owns the stream.
								body = body.pipe(
									Stream.takeWhileEffect(() =>
										authenticate(auth, request).pipe(
											Effect.map((current) => current.scopes.includes("read")),
											Effect.timeout("2 seconds"),
											Effect.orElseSucceed(() => false),
										),
									),
									Stream.interruptWhen(
										Effect.gen(function* () {
											yield* Effect.sleep(Math.max(0, credential.expiresAt - (yield* Clock.currentTimeMillis)));
										}),
									),
								);
							}
							const forwarded = HttpServerResponse.empty({
								status: response.status,
								cookies: connection.has("set-cookie")
									? Cookies.empty
									: Cookies.fromIterable(
											Object.values(response.cookies.cookies).filter(
												(cookie) =>
													cookie.name !== sessionCookie &&
													cookie.name !== oidcCookie &&
													(ingress?.applicationManagedIngress !== true ||
														cookie.name.startsWith(applicationCookiePrefix)),
											),
										),
							}).pipe(
								HttpServerResponse.setBody(HttpBody.stream(body, responseHeaders["content-type"] ?? "")),
								HttpServerResponse.setHeaders(responseHeaders),
							);
							return responseHeaders["content-type"] === undefined
								? HttpServerResponse.removeHeader(forwarded, "content-type")
								: forwarded;
						}),
					),
					Effect.orElseSucceed(unavailable),
					Effect.map(expires),
				);
			}),
		);
	const routed = Effect.gen(function* () {
		if (grant) {
			// A grant never falls through to another credential path, the secret branch or managed ingress.
			const publicResponse = yield* publicRoute;
			if (publicResponse) return publicResponse;
			const channel = yield* grantChannel(request, child);
			if (channel === null || !grantPathAllowed(request.method, url)) return authErrorResponse("grant_forbidden");
			if ((yield* Ref.get(phase))._tag === "Stopping") return authErrorResponse("boot_unavailable", 503);
			// The enclosing app request is itself admitted, so nothing past here may wait on a freeze or the operation
			// gate: admission, page publication and reload each refuse with board_busy instead of queuing.
			return yield* forward(false, false, channel.epoch);
		}
		// App bearer credentials cannot invoke boot surfaces or silently replace a supplied board session.
		if (
			applicationBearer &&
			(ingress?.applicationManagedIngress !== true || boardSession || isReservedIngressPath(path))
		)
			return authErrorResponse("token_invalid");
		// Recovery help carries a public yes/no on whether stored passkeys match an allowed origin; detail needs auth.
		if (path === "/_boot" && request.method === "GET") {
			const ok = yield* auth.passkeyOriginState.pipe(
				Effect.map((state): boolean | null => state.ok),
				Effect.orElseSucceed(() => null),
			);
			return HttpServerResponse.text(
				`${help}${
					ok === null
						? ""
						: ok
							? "\npasskey_origins_ok: true\n"
							: "\npasskey_origins_ok: false\nSome stored passkeys belong to no address this board serves. The operator can restore the previous origin variables or recover with REOPEN_SETUP=1; details are in the boot log and /_boot/status.\n"
				}`,
			);
		}
		const publicResponse = yield* publicRoute;
		if (publicResponse) return publicResponse;
		const grantResponse = yield* grantRoute(auth, authConfig, child);
		if (grantResponse) return grantResponse;
		if (
			request.headers["x-boot-secret"] !== undefined ||
			path.startsWith("/_boot/seq") ||
			path === "/_boot/events/append"
		) {
			const internal = yield* eventRoute(
				events,
				child.attempts,
				null,
				child.channelGate,
				child.traffic.route,
				Effect.succeed(true),
				captures,
			);
			if (internal) return internal;
		}
		if ((yield* Ref.get(phase))._tag === "Stopping") return authErrorResponse("boot_unavailable", 503);
		const recoveryResponse = yield* recoveryRoute(auth);
		if (recoveryResponse) return recoveryResponse;
		const settingsResponse = yield* settingsRoute(auth);
		if (settingsResponse) return settingsResponse;
		const restarted = yield* restartRoute(auth, restart);
		if (restarted) return restarted;
		const authResponse = yield* authRoute(auth, requestId);
		if (authResponse) return authResponse;
		const oidcResponse = yield* oidcRoute(auth, requestId);
		if (oidcResponse) return oidcResponse;
		const passkeyResponse = yield* passkeyManagementRoute(auth);
		if (passkeyResponse) return passkeyResponse;
		const passkeyCodeResponse = yield* passkeyCodeRoute(auth);
		if (passkeyCodeResponse) return passkeyCodeResponse;
		const enrollmentResponse = yield* enrollmentRoute(auth, authConfig, editing);
		if (enrollmentResponse) return enrollmentResponse;
		if ((yield* Ref.get(phase))._tag !== "Ready" && request.method === "POST" && path === "/_boot/db/backup")
			return authErrorResponse("boot_unavailable", 503);
		const backupResponse = yield* backupRoute(auth, backups, captures);
		if (backupResponse) return backupResponse;
		const restored = yield* databaseRestoreRoute(restores, auth);
		if (restored) return restored;
		const accountResponse = yield* accountRoute(auth);
		if (accountResponse) return accountResponse;
		const mintResponse = yield* tokenMintRoute(auth);
		if (mintResponse) return mintResponse;
		const tokenResponse = yield* tokenRoute(auth);
		if (tokenResponse) return tokenResponse;
		const explicitCredential = (request.headers.authorization !== undefined && !applicationBearer) || boardSession;
		const isPublic =
			(request.method === "GET" || request.method === "HEAD") &&
			[
				"/onboarding",
				"/favicon.svg",
				"/assets/board.js",
				"/assets/style.css",
				"/init",
				"/init.md",
				"/page-assets/markdown.css",
				"/page-assets/highlight.css",
				"/page-assets/mermaid.js",
				"/page-assets/mermaid-init.js",
				"/page-assets/tailwind.js",
			].includes(path);
		const managedIngress =
			!explicitCredential &&
			(!isPublic || applicationBearer) &&
			ingress?.applicationManagedIngress === true &&
			!isReservedIngressPath(path);
		return yield* forward((!isPublic && !managedIngress) || explicitCredential, managedIngress);
	}).pipe(Effect.tap((response) => (observed ? observed.respond(response) : Effect.void)));
	return yield* observed ? routed.pipe(Effect.withParentSpan(observed.span)) : routed;
});

/** Immutable liveness/help and control-path exclusion work before the store can open. */
export const publicRoute = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest;
	const path = new URL(request.url, "http://localhost").pathname;
	// Reserve the child control namespace before any public or authenticated admission.
	const controlPath = yield* Effect.try(() => {
		const incomingPath = request.url.startsWith("/") ? new URL(`http://localhost${request.url}`).pathname : path;
		return new URL(`http://localhost${decodeURIComponent(incomingPath).replaceAll("\\", "/").replace(/\/+/g, "/")}`)
			.pathname;
	}).pipe(Effect.orElseSucceed(() => null));
	if (controlPath === null) return HttpServerResponse.empty({ status: 400 });
	if (controlPath === "/_kernel" || controlPath.startsWith("/_kernel/"))
		return HttpServerResponse.empty({ status: 403 });
	if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) {
		return HttpServerResponse.jsonUnsafe({ status: "ok", revision: yield* buildRevision });
	}
	if (path === "/.well-known/agent.json") {
		if (request.method !== "GET" && request.method !== "HEAD")
			return HttpServerResponse.empty({ status: 405, headers: { allow: "GET, HEAD" } });
		return HttpServerResponse.jsonUnsafe(recoveryManifest(yield* buildRevision), {
			headers: { "cache-control": "no-store" },
		});
	}
	if (path === "/_boot" && request.method === "GET") return HttpServerResponse.text(help);
	return null;
});
