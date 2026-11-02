import { assertionHeader } from "@comms/protocol/headers";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { BoardError } from "./board-api.ts";
import { accountPost, accountRequest, unreadable } from "./account-api.ts";

const descriptor = Schema.Struct({ id: Schema.String, type: Schema.Literal("public-key") });
const Authentication = Schema.Struct({
	id: Schema.String,
	options: Schema.Struct({
		challenge: Schema.String,
		rpId: Schema.String,
		timeout: Schema.Finite,
		userVerification: Schema.Literals(["required", "preferred", "discouraged"]),
		allowCredentials: Schema.optionalKey(Schema.Array(descriptor)),
	}),
});
const Registration = Schema.Struct({
	id: Schema.String,
	options: Schema.Struct({
		challenge: Schema.String,
		rp: Schema.Struct({ id: Schema.String, name: Schema.String }),
		user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
		pubKeyCredParams: Schema.Array(Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Finite })),
		timeout: Schema.Finite,
		excludeCredentials: Schema.optionalKey(Schema.Array(descriptor)),
	}),
});
const decode = (value: string) =>
	Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (letter) => letter.charCodeAt(0));
const encode = (value: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(value)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
/** The browser's reason, by DOMException name only: its message text is browser-specific and stays private. */
const ceremonyMessage = (ceremony: "create" | "get", name: string) => {
	if (!window.isSecureContext) return "Passkeys need HTTPS or http://localhost. Open this board over HTTPS.";
	switch (name) {
		case "InvalidStateError":
			return "This device or password manager already has a passkey for this board, so there is nothing to add here. Use that passkey, or add one from a device that does not share it.";
		case "NotAllowedError":
			return ceremony === "create"
				? "The passkey prompt was closed, timed out, or blocked by the browser. Try again."
				: "No passkey for this address confirmed the request. Use a device that has one; to add a passkey to a device without one, generate an add-passkey code on a device that has one.";
		case "SecurityError":
			return "This address cannot use the board's passkeys. Open the board at its configured address.";
		case "NotSupportedError":
			return "This browser has no passkey provider for this request. Try another browser or device.";
		case "AbortError":
			return "The passkey request was interrupted. Try again.";
		default:
			return "Your browser could not complete the passkey request. Try again.";
	}
};
const ceremonyError = (ceremony: "create" | "get") => (cause?: unknown) => {
	const name = cause instanceof DOMException ? cause.name : "";
	return new BoardError({
		status: 0,
		message: ceremonyMessage(ceremony, name) + (name ? ` (${name})` : ""),
		...(name ? { code: name } : {}),
	});
};
export const confirmAccountAction = (action: string, params: unknown) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/challenge", { action, params }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Authentication)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const credential = yield* Effect.tryPromise({
			try: () =>
				navigator.credentials.get({
					publicKey: {
						...started.options,
						challenge: decode(started.options.challenge),
						allowCredentials: (started.options.allowCredentials ?? []).map((item) => ({
							...item,
							id: decode(item.id),
						})),
					},
				}),
			catch: ceremonyError("get"),
		});
		if (
			!(credential instanceof PublicKeyCredential) ||
			!(credential.response instanceof AuthenticatorAssertionResponse)
		)
			return yield* ceremonyError("get")();
		const response = credential.response;
		const extensions = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
			credential.getClientExtensionResults(),
		).pipe(Effect.catchTag("SchemaError", () => unreadable));
		const proof = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
			id: started.id,
			response: {
				id: credential.id,
				rawId: encode(credential.rawId),
				type: "public-key",
				clientExtensionResults: extensions,
				response: {
					clientDataJSON: encode(response.clientDataJSON),
					authenticatorData: encode(response.authenticatorData),
					signature: encode(response.signature),
					...(response.userHandle ? { userHandle: encode(response.userHandle) } : {}),
				},
			},
		}).pipe(Effect.catchTag("SchemaError", () => unreadable));
		return encode(new TextEncoder().encode(proof));
	});
export const addPasskey = (label: string) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/passkeys/options", { label }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const response = yield* registerPasskey(started);
		const proof = yield* confirmAccountAction("passkey.add", { registration: started.id, label, response });
		yield* accountPost("/_boot/auth/passkeys/verify", { id: started.id, label, response }, proof);
	});
export const deletePasskey = (id: string) =>
	Effect.gen(function* () {
		const proof = yield* confirmAccountAction("passkey.delete", { id });
		yield* accountRequest(
			HttpClientRequest.delete(
				new URL(`/_boot/auth/passkeys/${encodeURIComponent(id)}`, window.location.origin).href,
			).pipe(HttpClientRequest.bodyJsonUnsafe({}), HttpClientRequest.setHeader(assertionHeader, proof)),
		);
	});

const registerPasskey = (started: typeof Registration.Type) =>
	Effect.gen(function* () {
		const credential = yield* Effect.tryPromise({
			try: () =>
				navigator.credentials.create({
					publicKey: {
						...started.options,
						challenge: decode(started.options.challenge),
						user: { ...started.options.user, id: decode(started.options.user.id) },
						pubKeyCredParams: [...started.options.pubKeyCredParams],
						excludeCredentials: (started.options.excludeCredentials ?? []).map((item) => ({
							...item,
							id: decode(item.id),
						})),
						attestation: "none",
						authenticatorSelection: { residentKey: "required", userVerification: "required" },
					},
				}),
			catch: ceremonyError("create"),
		});
		if (
			!(credential instanceof PublicKeyCredential) ||
			!(credential.response instanceof AuthenticatorAttestationResponse)
		)
			return yield* ceremonyError("create")();
		const extensions = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
			credential.getClientExtensionResults(),
		).pipe(Effect.catchTag("SchemaError", () => unreadable));
		return {
			id: credential.id,
			rawId: encode(credential.rawId),
			type: "public-key",
			clientExtensionResults: extensions,
			response: {
				clientDataJSON: encode(credential.response.clientDataJSON),
				attestationObject: encode(credential.response.attestationObject),
				transports: credential.response.getTransports(),
			},
		};
	});

/** First registration also signs in: boot answers setup/verify with the session cookie. */
export const setupPasskey = (code: string) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/setup/options", { code: code.trim() }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		const response = yield* registerPasskey(started);
		yield* accountPost("/_boot/auth/setup/verify", { id: started.id, response });
	});
