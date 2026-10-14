import { assertionHeader } from "@comms/protocol/headers";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { accountPost, accountRequest, unreadable } from "./account-api.ts";
import { confirmAccountAction } from "./account-passkeys.ts";

const Provider = Schema.Literals(["github", "google"]);
const Pending = Schema.Struct({
	id: Schema.String,
	provider: Provider,
	label: Schema.String,
	expires_at: Schema.Finite,
});
const Identities = Schema.Struct({
	identities: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			issuer: Schema.String,
			provider: Provider,
			label: Schema.String,
			created_at: Schema.Finite,
			last_used_at: Schema.NullOr(Schema.Finite),
			active: Schema.Boolean,
		}),
	),
	pending: Schema.Array(Pending),
	providers: Schema.Array(Provider),
});
const Started = Schema.Struct({ authorization_url: Schema.String });
export type Provider = typeof Provider.Type;
export type IdentityList = typeof Identities.Type;
export type PendingIdentity = typeof Pending.Type;

/** Boot returns to /@user?link=<id>. Match that id so a later pending row is not confirmed by mistake. */
export const pendingForHref = (pending: IdentityList["pending"], href: string) => {
	const id = new URL(href).searchParams.get("link");
	return id === null ? pending[0] : pending.find((row) => row.id === id);
};

export const getIdentities = Effect.suspend(() =>
	accountRequest(HttpClientRequest.get(new URL("/_boot/auth/identities", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Identities)),
		Effect.catchTag("SchemaError", () => unreadable),
	),
);
/** The issuer is another origin, so the page navigates there itself; a form redirect would break form-action 'self'.
 * Boot sends the human back to this page with ?link=, where the passkey confirms the link. */
export const startLink = (provider: Provider) =>
	Effect.gen(function* () {
		const started = yield* accountPost("/_boot/auth/oidc/start", { intent: "link", provider }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Started)),
			Effect.catchTag("SchemaError", () => unreadable),
		);
		yield* Effect.sync(() => window.location.assign(started.authorization_url));
	});
export const confirmLink = (pending: string) =>
	Effect.gen(function* () {
		const proof = yield* confirmAccountAction("identity.link", { id: pending });
		yield* accountPost("/_boot/auth/identities", { pending }, proof);
	});
export const unlinkIdentity = (id: string) =>
	Effect.gen(function* () {
		const proof = yield* confirmAccountAction("identity.unlink", { id });
		yield* accountRequest(
			HttpClientRequest.delete(
				new URL(`/_boot/auth/identities/${encodeURIComponent(id)}`, window.location.origin).href,
			).pipe(HttpClientRequest.bodyJsonUnsafe({}), HttpClientRequest.setHeader(assertionHeader, proof)),
		);
	});
