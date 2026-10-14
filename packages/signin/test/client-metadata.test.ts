import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createServer } from "node:https";
import { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { expect, it } from "vitest";
import * as ClientMetadata from "../src/client-metadata.ts";
import { boardRedirect, documentServer, serve } from "./fixtures/signin.ts";
import { testCertificates } from "./fixtures/tls.ts";

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
		// The test-only mode still refuses IP literals.
		expect(await loopback(`http://[::1]:${new URL(clients.url("/")).port}/auth/oidc/client.json`)).toBe(
			"invalid_client_id",
		);
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

it.each([
	["8.8.8.8", true],
	["172.32.0.1", true],
	["2001:4860::", true],
	["2001:200::1", true],
	["10.0.0.1", false],
	["10.255.255.255", false],
	["100.64.0.1", false],
	["100.127.255.255", false],
	["169.254.169.254", false],
	["172.16.0.1", false],
	["172.31.255.255", false],
	["192.168.1.1", false],
	["192.0.0.1", false],
	["192.0.2.1", false],
	["192.31.196.1", false],
	["192.52.193.1", false],
	["192.88.99.1", false],
	["192.175.48.1", false],
	["198.18.0.1", false],
	["198.19.255.255", false],
	["198.51.100.1", false],
	["203.0.113.1", false],
	["224.0.0.1", false],
	["255.255.255.255", false],
	["0.0.0.0", false],
	["127.0.0.1", false],
	["::", false],
	["::1", false],
	["::ffff:127.0.0.1", false],
	["::ffff:8.8.8.8", false],
	["::ffff:192.31.196.1", false],
	["::127.0.0.1", false],
	["::192.52.193.1", false],
	["64:ff9b::808:808", false],
	["64:ff9b::192.31.196.1", false],
	["2002::1", false],
	["2001::1", false],
	["2001:3::1", false],
	["2001:db8::1", false],
	["2620:4f:8000::1", false],
	["fc00::1", false],
	["fdaa::3", false],
	["fe80::1", false],
	["ff02::1", false],
	["3fff::1", false],
	["localhost", false],
] as const)("classifies %s as public: %s", (address, expected) => {
	expect(ClientMetadata.makeAddressPolicy().public(address)).toBe(expected);
});

it.each([
	["127.0.0.1", true],
	["127.255.0.1", true],
	["::1", true],
	["::2", false],
	["10.0.0.1", false],
	["8.8.8.8", false],
] as const)("classifies %s as loopback for the test-only mode: %s", (address, expected) => {
	expect(ClientMetadata.makeAddressPolicy().loopback(address)).toBe(expected);
});

it("under Bun, connects to the checked address with the hostname for SNI, Host and the certificate", async () => {
	const certificates = await testCertificates(["localhost", "other.test"]);
	const { address } = await lookup("localhost", { verbatim: true });
	const seen: Array<{ host: string | undefined; servername: string | false | null; path: string | undefined }> = [];
	const listen = async (name: string) => {
		const server = createServer(certificates.leaf(name), (request, response) => {
			const port = request.socket.localPort;
			seen.push({
				host: request.headers.host,
				servername: request.socket instanceof TLSSocket ? request.socket.servername : false,
				path: request.url,
			});
			const clientId = `https://localhost:${port}/client.json`;
			if (request.url === "/moved.json") response.writeHead(302, { location: clientId }).end();
			else
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(
						JSON.stringify({ client_id: clientId, redirect_uris: [boardRedirect], token_endpoint_auth_method: "none" }),
					);
		});
		await new Promise<void>((resolve) => server.listen(0, address, resolve));
		const bound = server.address();
		if (bound === null || typeof bound === "string") throw new Error("Expected a TCP listener");
		return { port: bound.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
	};
	const right = await listen("localhost");
	const wrong = await listen("other.test");
	try {
		const { stdout } = await promisify(execFile)(
			"bun",
			[
				fileURLToPath(new URL("./fixtures/resolve-clients.ts", import.meta.url)),
				boardRedirect,
				`https://localhost:${right.port}/client.json`,
				`https://localhost:${right.port}/moved.json`,
				`https://localhost:${wrong.port}/client.json`,
			],
			{ env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_EXTRA_CA_CERTS: certificates.ca } },
		);
		expect(JSON.parse(stdout)).toEqual(["https://board.test", "redirected", "unreachable"]);
		// Both requests to the right server carried the hostname; the wrong certificate never got a request.
		expect(seen).toEqual([
			{ host: `localhost:${right.port}`, servername: "localhost", path: "/client.json" },
			{ host: `localhost:${right.port}`, servername: "localhost", path: "/moved.json" },
		]);
	} finally {
		await right.close();
		await wrong.close();
		await certificates.remove();
	}
}, 20_000);
