// DNS answers and address classification have no Effect platform service; keep them inside this module.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { lookup } from "node:dns/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { BlockList, isIP } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { checkServerIdentity } from "node:tls";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const reasons = [
	"invalid_client_id",
	"invalid_redirect_uri",
	"private_address",
	"unreachable",
	"redirected",
	"too_large",
	"invalid_document",
	"client_id_mismatch",
	"unsupported_auth_method",
	"unregistered_redirect_uri",
] as const;
export class ClientError extends Schema.TaggedError<ClientError>()("ClientError", {
	reason: Schema.Literals(reasons),
}) {}

const maxBytes = 8 * 1024;
const maxUrl = 512;
const Document = Schema.Struct({
	client_id: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
	token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});

/**
 * Globally routable unicast only, per the IANA special-purpose registries; IPv4-mapped IPv6 is refused.
 * Everything outside 2000::/3 is refused, which covers ULA and so Fly's private 6PN network (fdaa::/16).
 */
export const makeAddressPolicy = () => {
	const reserved = new BlockList();
	for (const [network, prefix] of [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 3],
	] as const)
		reserved.addSubnet(network, prefix, "ipv4");
	for (const [network, prefix] of [
		["2001::", 23],
		["2001:db8::", 32],
		["2002::", 16],
		["3fff::", 20],
	] as const)
		reserved.addSubnet(network, prefix, "ipv6");
	const global = new BlockList();
	global.addSubnet("2000::", 3, "ipv6");
	const loopback = new BlockList();
	loopback.addSubnet("127.0.0.0", 8, "ipv4");
	loopback.addAddress("::1", "ipv6");
	return {
		public: (address: string) => {
			const family = isIP(address);
			if (family === 4) return !reserved.check(address, "ipv4");
			return family === 6 && global.check(address, "ipv6") && !reserved.check(address, "ipv6");
		},
		loopback: (address: string) => {
			const family = isIP(address);
			return family !== 0 && loopback.check(address, family === 4 ? "ipv4" : "ipv6");
		},
	};
};

/**
 * Client ID Metadata Document resolution. `allowLoopback` additionally accepts `http://localhost` and
 * `https://localhost` documents served from a loopback address; it exists only for tests and is never enabled by
 * the production layer.
 */
const make = (options: { readonly allowLoopback: boolean }) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const addresses = makeAddressPolicy();
		const refuse = (reason: (typeof reasons)[number]) => new ClientError({ reason });

		/** https with a path; no userinfo, query, fragment, dot segments or IP-literal host. Canonical, so string compare is exact. */
		const clientIdUrl = (value: string) => {
			const url = URL.parse(value);
			if (!url || value.length > maxUrl || url.href !== value) return undefined;
			const local =
				options.allowLoopback &&
				url.hostname === "localhost" &&
				(url.protocol === "http:" || url.protocol === "https:");
			return (url.protocol === "https:" || local) &&
				!url.username &&
				!url.password &&
				!value.includes("?") &&
				!value.includes("#") &&
				url.pathname !== "/" &&
				isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0
				? { url, local }
				: undefined;
		};
		const redirectUrl = (value: string) => {
			const url = URL.parse(value);
			return url &&
				value.length <= maxUrl &&
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!value.includes("#")
				? url
				: undefined;
		};

		/**
		 * Connect only to an address checked here, keeping the hostname for SNI and certificate checks, so DNS
		 * rebinding cannot point the fetch at a private address. Redirects are never followed.
		 */
		const fetchDocument = (url: URL, local: boolean) =>
			Effect.gen(function* () {
				const hostname = url.hostname;
				const resolved = yield* Effect.tryPromise(() => lookup(hostname, { all: true, verbatim: true })).pipe(
					Effect.mapError(() => refuse("unreachable")),
				);
				const first = resolved[0];
				if (!first) return yield* refuse("unreachable");
				if (resolved.some((item) => !(local ? addresses.loopback(item.address) : addresses.public(item.address))))
					return yield* refuse("private_address");
				const pinned = new URL(url.href);
				pinned.hostname = first.family === 6 ? `[${first.address}]` : first.address;
				const init: BunFetchRequestInit = {
					redirect: "manual",
					credentials: "omit",
					...(url.protocol === "https:"
						? {
								tls: {
									serverName: hostname,
									checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
								},
							}
						: {}),
				};
				const response = yield* client
					.execute(
						HttpClientRequest.get(pinned.href).pipe(
							HttpClientRequest.setHeaders({ host: url.host, accept: "application/json" }),
						),
					)
					.pipe(
						Effect.provideService(FetchHttpClient.RequestInit, init),
						Effect.mapError(() => refuse("unreachable")),
					);
				if (response.status >= 300 && response.status < 400) return yield* refuse("redirected");
				if (response.status !== 200) return yield* refuse("unreachable");
				const chunks: Array<Uint8Array> = [];
				let size = 0;
				yield* response.stream.pipe(
					Stream.takeWhile(() => size <= maxBytes),
					Stream.runForEach((chunk) =>
						Effect.sync(() => {
							size += chunk.byteLength;
							chunks.push(chunk);
						}),
					),
					Effect.mapError(() => refuse("unreachable")),
				);
				if (size > maxBytes) return yield* refuse("too_large");
				return yield* Schema.decodeEffect(Schema.fromJsonString(Document))(Buffer.concat(chunks).toString("utf8")).pipe(
					Effect.mapError(() => refuse("invalid_document")),
				);
			}).pipe(Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.fail(refuse("unreachable")) }));

		/** Fetch the client's document and check the request's redirect_uri against it. No result is cached. */
		const resolve = (clientId: string, redirectUri: string) =>
			Effect.gen(function* () {
				const checked = clientIdUrl(clientId);
				if (!checked) return yield* refuse("invalid_client_id");
				const redirect = redirectUrl(redirectUri);
				if (!redirect) return yield* refuse("invalid_redirect_uri");
				const document = yield* fetchDocument(checked.url, checked.local);
				if (document.client_id !== clientId) return yield* refuse("client_id_mismatch");
				if (document.token_endpoint_auth_method !== "none") return yield* refuse("unsupported_auth_method");
				if (!document.redirect_uris.includes(redirectUri)) return yield* refuse("unregistered_redirect_uri");
				return { clientId, redirectUri, redirectOrigin: redirect.origin } as const;
			});
		return { resolve } as const;
	});

export class ClientMetadata extends Context.Service<ClientMetadata, Effect.Success<ReturnType<typeof make>>>()(
	"comms/signin/ClientMetadata",
) {}

export const layer = Layer.effect(ClientMetadata, make({ allowLoopback: false }));

/** Tests only: also resolves `http(s)://localhost` client documents. Never wire this into main.ts. */
export const loopbackLayerForTests = Layer.effect(ClientMetadata, make({ allowLoopback: true }));
