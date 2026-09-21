import { Config, Context, Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { ReleaseChannel } from "./board.ts";

// Resolves a release channel tag to one immutable image digest through the OCI distribution API:
// HEAD the manifest and read the Docker-Content-Digest header. A public registry still demands a
// bearer token, obtained anonymously by answering the WWW-Authenticate challenge.
// Contracts: https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pulling-manifests
// and https://distribution.github.io/distribution/spec/auth/token/.

export class ImageRegistryError extends Data.TaggedError("ImageRegistryError")<{
	readonly channel: ReleaseChannel;
	readonly reason: "network" | "status" | "digest";
}> {}

export class ImageRegistryConfigurationError extends Data.TaggedError("ImageRegistryConfigurationError")<{
	readonly message: string;
}> {}

export interface ImageRepository {
	readonly host: string;
	readonly name: string;
}

// A multi-platform image is an index; accepting only a single-manifest type would 404 on it.
const manifestTypes = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// Registries answer with `token`, `access_token`, or both, per the token spec.
const TokenResponse = Schema.Struct({
	token: Schema.optional(Schema.String),
	access_token: Schema.optional(Schema.String),
});

const challengeUrl = (header: string | undefined) => {
	if (!header || !/^bearer\s/i.test(header)) return undefined;
	const fields = new Map<string, string>();
	for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) {
		const [, key, value] = match;
		if (key !== undefined && value !== undefined) fields.set(key.toLowerCase(), value);
	}
	const realm = fields.get("realm");
	if (!realm) return undefined;
	const url = new URL(realm);
	for (const key of ["service", "scope"]) {
		const value = fields.get(key);
		if (value) url.searchParams.set(key, value);
	}
	return url.href;
};

export const parseImageRepository = (value: string) => {
	const slash = value.indexOf("/");
	const host = value.slice(0, slash);
	const name = value.slice(slash + 1);
	return slash > 0 && host.includes(".") && /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(name) && !value.includes("@")
		? Effect.succeed({ host, name } satisfies ImageRepository)
		: Effect.fail(
				new ImageRegistryConfigurationError({
					message: "CHIRP_IMAGE_REPOSITORY must be a registry host and lowercase repository, without a tag",
				}),
			);
};

export const imageRepositorySetting = Config.String("CHIRP_IMAGE_REPOSITORY").pipe(
	Config.withDefault("ghcr.io/cryogenicplanet/chirp"),
);

const make = (repository: ImageRepository) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const reference = `${repository.host}/${repository.name}`;
		const resolve = (channel: ReleaseChannel) => {
			const failure = (reason: ImageRegistryError["reason"]) => new ImageRegistryError({ channel, reason });
			const manifest = (token?: string) =>
				HttpClientRequest.head(`https://${repository.host}/v2/${repository.name}/manifests/${channel}`).pipe(
					HttpClientRequest.setHeader("accept", manifestTypes),
					token === undefined ? (request) => request : HttpClientRequest.bearerToken(token),
				);
			const execute = (request: HttpClientRequest.HttpClientRequest) =>
				Effect.scoped(HttpClient.withScope(client).execute(request)).pipe(Effect.mapError(() => failure("network")));
			return Effect.gen(function* () {
				let response = yield* execute(manifest());
				if (response.status === 401) {
					const url = challengeUrl(response.headers["www-authenticate"]);
					if (url === undefined) return yield* failure("status");
					const issued = yield* Effect.scoped(
						HttpClient.withScope(client)
							.execute(HttpClientRequest.get(url))
							.pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse))),
					).pipe(Effect.mapError(() => failure("network")));
					const token = issued.token ?? issued.access_token;
					if (!token) return yield* failure("status");
					response = yield* execute(manifest(token));
				}
				if (response.status !== 200) return yield* failure("status");
				const digest = response.headers["docker-content-digest"];
				if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) return yield* failure("digest");
				return `${reference}@${digest}`;
			}).pipe(
				Effect.timeout("15 seconds"),
				Effect.catchTag("TimeoutError", () => Effect.fail(failure("network"))),
			);
		};
		return { resolve };
	});

export class ImageRegistry extends Context.Service<ImageRegistry, Effect.Success<ReturnType<typeof make>>>()(
	"comms/cloud/ImageRegistry",
) {}
export const imageRegistryLayer = (repository: ImageRepository) => Layer.effect(ImageRegistry, make(repository));
