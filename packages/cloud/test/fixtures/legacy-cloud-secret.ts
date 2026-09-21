import { Buffer } from "node:buffer";
import { createCipheriv } from "node:crypto";

export const encryptLegacyBootstrap = (
	keyHex: string,
	boardId: string,
	payload: { readonly adminUrl: string; readonly bootPassword: string; readonly appPassword: string },
	aad: "board" | "purpose",
) => {
	const nonce = Buffer.alloc(12, aad === "board" ? 1 : 2);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), nonce);
	cipher.setAAD(
		Buffer.from(
			JSON.stringify(
				aad === "board" ? ["chirp-cloud-postgres", 1, boardId] : ["chirp-cloud-postgres", 1, "bootstrap", boardId],
			),
		),
	);
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return [
		"v1",
		nonce.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		encrypted.toString("base64url"),
	].join(".");
};
