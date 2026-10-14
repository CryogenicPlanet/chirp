import { HttpServerResponse } from "effect/unstable/http";
import { expect, it } from "vitest";
import { consentPage } from "../src/pages.ts";
import type { Identity } from "../src/upstream.ts";

const heading = async (destination: string, clientId: string, identity: Identity) => {
	const page = await HttpServerResponse.toWeb(consentPage({ destination, clientId, identity, csrf: "token" })).text();
	return {
		title: /<h1>([^<]*)<\/h1>/.exec(page)?.[1],
		shared: /It will receive your ([^.]*)\./.exec(page)?.[1],
	};
};

const octocat: Identity = { provider: "github", sub: "github:4242", username: "octocat" };

it("names only the destination when the client document is on the same origin", async () => {
	expect(
		await heading("https://board.example.com", "https://board.example.com/auth/oidc/client.json", octocat),
	).toEqual({
		title: "Sign in to https://board.example.com as octocat on GitHub?",
		shared: "GitHub account id and username",
	});
});

it("also names the registering host when the client document is elsewhere", async () => {
	expect(
		(await heading("https://a.example.com", "https://e.example.net:8443/auth/oidc/client.json", octocat)).title,
	).toBe("Sign in to https://a.example.com (registered by e.example.net:8443) as octocat on GitHub?");
});

it("describes what a Google sign-in shares, with or without a verified email", async () => {
	const clientId = "https://board.example.com/auth/oidc/client.json";
	expect(
		await heading("https://board.example.com", clientId, {
			provider: "google",
			sub: "google:1",
			email: "person@example.com",
		}),
	).toEqual({
		title: "Sign in to https://board.example.com as person@example.com on Google?",
		shared: "Google account id and verified email",
	});
	expect(await heading("https://board.example.com", clientId, { provider: "google", sub: "google:1" })).toEqual({
		title: "Sign in to https://board.example.com as your Google account on Google?",
		shared: "Google account id",
	});
});
