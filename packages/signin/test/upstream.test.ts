import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "vitest";
import * as Settings from "../src/settings.ts";
import * as Upstream from "../src/upstream.ts";
import { fakeUpstream, type GoogleProfile, rawSettings, s256, verifier } from "./fixtures/signin.ts";

type Fake = Awaited<ReturnType<typeof fakeUpstream>>;

/** Sign in at the fake provider as a browser would, then finish it through the service. */
const identify = async (fake: Fake, provider: Upstream.Provider, options: { verifier?: string } = {}) => {
	const raw = await rawSettings();
	const run = <A>(effect: Effect.Effect<A, Upstream.UpstreamError, Upstream.Upstream>) =>
		Effect.runPromise(
			effect.pipe(
				Effect.map((value): A | string => value),
				Effect.catchTag("UpstreamError", (error) => Effect.succeed(`${error.provider}:${error.step}`)),
				Effect.provide(
					Upstream.layer(fake.endpoints).pipe(
						Layer.provide(Layer.mergeAll(Settings.fromRaw(raw), FetchHttpClient.layer)),
					),
				),
			),
		);
	const upstreamVerifier = verifier();
	const authorize = await run(
		Effect.gen(function* () {
			return (yield* Upstream.Upstream).authorizeUrl(provider, {
				state: "upstream-state",
				challenge: s256(upstreamVerifier),
			});
		}),
	);
	const redirected = await fetch(authorize, { redirect: "manual" });
	const code = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";
	return run(
		Effect.gen(function* () {
			return yield* (yield* Upstream.Upstream).identify(provider, code, options.verifier ?? upstreamVerifier);
		}),
	);
};

const withFake = (body: (fake: Fake) => Promise<void>) => async () => {
	const fake = await fakeUpstream();
	try {
		await body(fake);
	} finally {
		await fake.close();
	}
};

it(
	"uses GitHub's numeric account id as the subject and the login only as a label",
	withFake(async (fake) => {
		expect(await identify(fake, "github")).toEqual({ provider: "github", sub: "github:4242", username: "octocat" });
		fake.profile.github = { id: 4242, login: "renamed" };
		expect(await identify(fake, "github")).toEqual({ provider: "github", sub: "github:4242", username: "renamed" });
		const user = fake.requests.find((request) => request.path === "/github/user");
		expect(user?.headers.get("user-agent")).toBe("chirp-signin");
		expect(user?.headers.get("accept")).toBe("application/vnd.github+json");
	}),
);

it.each([
	[{ sub: "1098765", email: "person@example.com", email_verified: true }, { email: "person@example.com" }],
	[{ sub: "1098765", email: "person@example.com", email_verified: "true" }, { email: "person@example.com" }],
	[{ sub: "1098765", email: "person@example.com", email_verified: false }, {}],
	[{ sub: "1098765", email: "person@example.com" }, {}],
	[{ sub: "1098765" }, {}],
] satisfies Array<[GoogleProfile, Record<string, string>]>)(
	"includes a Google email only when Google verified it (%o)",
	(profile, label) =>
		withFake(async (fake) => {
			fake.profile.google = profile;
			expect(await identify(fake, "google")).toEqual({ provider: "google", sub: "google:1098765", ...label });
		})(),
);

it(
	"sends the PKCE verifier and client secret upstream and fails closed on a refused exchange",
	withFake(async (fake) => {
		expect(await identify(fake, "github", { verifier: verifier() })).toBe("github:token");
		expect(await identify(fake, "google", { verifier: verifier() })).toBe("google:token");
		fake.profile.github = { id: 0, login: "octocat" };
		expect(await identify(fake, "github")).toBe("github:user");
		const exchange = fake.requests.find((request) => request.path === "/google/token");
		expect(exchange?.params.get("client_secret")).toBe("google-secret");
		expect(exchange?.params.get("grant_type")).toBe("authorization_code");
	}),
);
