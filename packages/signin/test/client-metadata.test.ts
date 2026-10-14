import { Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { expect, it } from "vitest";
import * as ClientMetadata from "../src/client-metadata.ts";
import { boardRedirect, documentServer, serve } from "./fixtures/signin.ts";

type Clients = Awaited<ReturnType<typeof documentServer>>;

const resolve = (
	layer: Layer.Layer<ClientMetadata.ClientMetadata, never, HttpClient.HttpClient>,
	clientId: string,
	redirectUri = boardRedirect,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			return yield* (yield* ClientMetadata.ClientMetadata).resolve(clientId, redirectUri);
		}).pipe(
			Effect.map((client) => client.redirectOrigin),
			Effect.catchTag("ClientError", (error) => Effect.succeed(error.reason)),
			Effect.provide(layer.pipe(Layer.provide(FetchHttpClient.layer))),
		),
	);
const loopback = (clientId: string, redirectUri?: string) =>
	resolve(ClientMetadata.loopbackLayerForTests, clientId, redirectUri);

const withDocuments = (body: (clients: Clients) => Promise<void>) => async () => {
	const clients = await documentServer();
	try {
		await body(clients);
	} finally {
		await clients.close();
	}
};

it(
	"accepts a board document and names the redirect origin",
	withDocuments(async (clients) => {
		expect(await loopback(clients.board())).toBe("https://board.test");
	}),
);

it.each([
	["http scheme", "http://board.example.com/auth/oidc/client.json"],
	["no path", "https://board.example.com/"],
	["a query", "https://board.example.com/client.json?x=1"],
	["an empty query", "https://board.example.com/client.json?"],
	["a fragment", "https://board.example.com/client.json#x"],
	["userinfo", "https://user:pass@board.example.com/client.json"],
	["a dot segment", "https://board.example.com/a/../client.json"],
	["an IPv4 literal", "https://93.184.216.34/client.json"],
	["an IPv6 literal", "https://[2606:2800:220:1::1]/client.json"],
	["a non-canonical host", "https://Board.Example.com/client.json"],
	["not a URL", "board"],
])("refuses a client_id with %s before fetching", async (_name, clientId) => {
	expect(await resolve(ClientMetadata.layer, clientId)).toBe("invalid_client_id");
});

it("refuses a redirect_uri that is not https or carries a fragment", async () => {
	expect(await resolve(ClientMetadata.layer, "https://board.example.com/c.json", "http://board.example.com/cb")).toBe(
		"invalid_redirect_uri",
	);
	expect(
		await resolve(ClientMetadata.layer, "https://board.example.com/c.json", "https://board.example.com/cb#x"),
	).toBe("invalid_redirect_uri");
});

it(
	"refuses hosts that resolve to loopback or private addresses in production",
	withDocuments(async (clients) => {
		clients.board();
		// The production layer resolves localhost, sees a loopback address and never connects.
		expect(await resolve(ClientMetadata.layer, "https://localhost/auth/oidc/client.json")).toBe("private_address");
		expect(
			await resolve(ClientMetadata.layer, `https://localhost:${new URL(clients.url("/")).port}/auth/oidc/client.json`),
		).toBe("private_address");
		// The test-only mode does not widen https: only http://localhost documents.
		expect(await loopback("https://localhost/auth/oidc/client.json")).toBe("private_address");
	}),
);

it(
	"does not follow redirects",
	withDocuments(async (clients) => {
		const target = clients.board("/real.json");
		clients.documents.set("/moved.json", () => new Response(null, { status: 302, headers: { location: target } }));
		expect(await loopback(clients.url("/moved.json"))).toBe("redirected");
	}),
);

it(
	"refuses documents over 8 KB without reading them whole",
	withDocuments(async (clients) => {
		const clientId = clients.url("/big.json");
		clients.documents.set("/big.json", () =>
			Response.json({
				client_id: clientId,
				redirect_uris: [boardRedirect],
				token_endpoint_auth_method: "none",
				padding: "x".repeat(9000),
			}),
		);
		expect(await loopback(clientId)).toBe("too_large");
	}),
);

it(
	"refuses a document whose client_id differs from its URL",
	withDocuments(async (clients) => {
		const other = clients.url("/other.json");
		clients.board("/client.json", { client_id: other });
		expect(await loopback(clients.url("/client.json"))).toBe("client_id_mismatch");
	}),
);

it(
	"refuses a redirect_uri not listed exactly",
	withDocuments(async (clients) => {
		const clientId = clients.board();
		expect(await loopback(clientId, "https://board.test/auth/oidc/callback/")).toBe("unregistered_redirect_uri");
		expect(await loopback(clientId, "https://evil.test/auth/oidc/callback")).toBe("unregistered_redirect_uri");
	}),
);

it(
	"requires token_endpoint_auth_method none",
	withDocuments(async (clients) => {
		const clientId = clients.board("/secret.json", { token_endpoint_auth_method: "client_secret_post" });
		expect(await loopback(clientId)).toBe("unsupported_auth_method");
		const implicit = clients.board("/implicit.json", { token_endpoint_auth_method: undefined });
		expect(await loopback(implicit)).toBe("unsupported_auth_method");
	}),
);

it(
	"refuses missing, non-JSON and mis-shaped documents",
	withDocuments(async (clients) => {
		expect(await loopback(clients.url("/absent.json"))).toBe("unreachable");
		clients.documents.set("/html.json", () => new Response("<html></html>"));
		expect(await loopback(clients.url("/html.json"))).toBe("invalid_document");
		const clientId = clients.url("/shape.json");
		clients.documents.set("/shape.json", () => Response.json({ client_id: clientId, redirect_uris: "x" }));
		expect(await loopback(clientId)).toBe("invalid_document");
	}),
);

it("gives up on a document server that stalls past three seconds", async () => {
	const stalled = await serve("localhost", () => new Promise<Response>(() => {}));
	try {
		const started = performance.now();
		expect(await loopback(`http://localhost:${stalled.port}/client.json`)).toBe("unreachable");
		expect(performance.now() - started).toBeLessThan(4500);
	} finally {
		await stalled.close();
	}
}, 10_000);
