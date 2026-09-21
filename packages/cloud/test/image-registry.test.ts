import { Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, test } from "vitest";
import { ImageRegistry, imageRegistryLayer, parseImageRepository } from "../src/image-registry.ts";

const digest = `sha256:${"b".repeat(64)}`;
const repository = { host: "ghcr.io", name: "cryogenicplanet/chirp" };

interface Seen {
	readonly method: string;
	readonly url: string;
	readonly accept: string | undefined;
	readonly authorization: string | undefined;
}

// Answers the way GHCR does for a public image: an unauthenticated manifest request is challenged,
// the realm issues an anonymous token, and the authenticated HEAD carries the digest header.
const ghcr = (seen: Array<Seen>, manifest: (authorized: boolean) => Response) =>
	HttpClient.make((request, url) => {
		seen.push({
			method: request.method,
			url: url.href,
			accept: request.headers.accept,
			authorization: request.headers.authorization,
		});
		if (url.pathname === "/token")
			return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ token: "anonymous" })));
		return Effect.succeed(
			HttpClientResponse.fromWeb(request, manifest(request.headers.authorization === "Bearer anonymous")),
		);
	});

const challenged = (authorized: boolean) =>
	authorized
		? new Response(null, { status: 200, headers: { "docker-content-digest": digest } })
		: new Response(null, {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:cryogenicplanet/chirp:pull"',
				},
			});

const resolve = (client: HttpClient.HttpClient, channel: "latest" | "canary") =>
	Effect.runPromiseExit(
		ImageRegistry.use((registry) => registry.resolve(channel)).pipe(
			Effect.provide(imageRegistryLayer(repository).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
		),
	);

describe("ImageRegistry", () => {
	test("resolves a channel to a digest-pinned reference through the anonymous token challenge", async () => {
		const seen: Array<Seen> = [];
		const exit = await resolve(ghcr(seen, challenged), "canary");
		expect(exit).toStrictEqual(Exit.succeed(`ghcr.io/cryogenicplanet/chirp@${digest}`));
		expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
			"HEAD https://ghcr.io/v2/cryogenicplanet/chirp/manifests/canary",
			"GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Acryogenicplanet%2Fchirp%3Apull",
			"HEAD https://ghcr.io/v2/cryogenicplanet/chirp/manifests/canary",
		]);
		// A multi-platform release is an image index; asking only for a single manifest would 404.
		expect(seen[0]?.accept).toContain("application/vnd.oci.image.index.v1+json");
		expect(seen[2]?.authorization).toBe("Bearer anonymous");
	});

	test("refuses a reference that is not pinned to a sha256 digest", async () => {
		const exit = await resolve(
			ghcr([], (authorized) =>
				authorized
					? new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:short" } })
					: challenged(false),
			),
			"latest",
		);
		expect(exit).toMatchObject({ _tag: "Failure" });
		expect(JSON.stringify(exit)).toContain('"reason":"digest"');
	});

	test("reports a missing tag as a status failure rather than inventing a digest", async () => {
		const exit = await resolve(
			ghcr([], (authorized) => (authorized ? new Response(null, { status: 404 }) : challenged(false))),
			"latest",
		);
		expect(JSON.stringify(exit)).toContain('"reason":"status"');
	});

	test("accepts a registry repository and rejects tags, digests and bare names", async () => {
		expect(await Effect.runPromise(parseImageRepository("ghcr.io/cryogenicplanet/chirp"))).toEqual(repository);
		for (const invalid of ["chirp", "ghcr.io/cryogenicplanet/chirp:latest", `ghcr.io/cryogenicplanet/chirp@${digest}`])
			expect(Exit.isFailure(await Effect.runPromiseExit(parseImageRepository(invalid)))).toBe(true);
	});
});
