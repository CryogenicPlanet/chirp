import { requestIdHeader } from "@comms/protocol/headers";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { authClient, authPage } from "../src/auth-page.ts";

it.each([
	["network", "options request", "could not reach"],
	["html", "options response", "unreadable response"],
	["redirect", "options response", "was redirected"],
	["decode", "options decode", "could not be prepared"],
	["create", "credential create", "NotAllowedError"],
	["get", "credential get", "NotAllowedError"],
	["verify", "verify request", "could not reach"],
])("identifies %s failures without exposing credential or browser error contents", async (scenario, stage, hint) => {
	const status = { textContent: "" },
		button = { disabled: false };
	let submit: (() => Promise<void>) | undefined;
	const requests: string[] = [];
	const progress: string[] = [];
	const requestId = "1234567890abcdef1234567890abcdef";
	class Attestation {
		clientDataJSON = new Uint8Array([1]).buffer;
		attestationObject = new Uint8Array([2]).buffer;
	}
	const credential = {
		id: "private-credential",
		rawId: new Uint8Array([3]).buffer,
		type: "public-key",
		getClientExtensionResults: () => ({}),
		response: new Attestation(),
	};
	const authenticate = async () => {
		progress.push(status.textContent);
		if (scenario === "create" || scenario === "get") throw new DOMException("private-browser-error", "NotAllowedError");
		return credential;
	};
	runInNewContext(authClient, {
		document: {
			querySelectorAll: () => [],
			getElementById: (id: string) =>
				id === "status"
					? status
					: id === "code"
						? { value: "private-setup-code" }
						: {
								dataset: { mode: scenario === "get" ? "login" : "setup" },
								querySelector: () => button,
								addEventListener: (
									_name: string,
									callback: (event: { preventDefault: () => void }) => Promise<void>,
								) => {
									submit = () => callback({ preventDefault: () => {} });
								},
							},
		},
		window: {
			isSecureContext: true,
			location: {
				search: "",
				hash: "",
				assign: () => {
					throw new Error("Unexpected redirect");
				},
			},
		},
		navigator: { credentials: { create: authenticate, get: authenticate } },
		AuthenticatorAttestationResponse: Attestation,
		URLSearchParams,
		atob,
		btoa,
		Uint8Array,
		fetch: async (path: string, init: RequestInit) => {
			requests.push(path);
			expect(init.redirect).toBe("manual");
			if (scenario === "network" || (scenario === "verify" && path.endsWith("/verify")))
				throw new Error("private-network-error");
			if (scenario === "html") return new Response("private-html", { status: 401 });
			if (scenario === "redirect") return new Response(null, { status: 302 });
			return Response.json(
				{ id: "private-challenge", options: scenario === "decode" ? {} : { challenge: "YWJj", user: { id: "YWJj" } } },
				{ headers: { [requestIdHeader]: requestId } },
			);
		},
	});
	if (!submit) throw new Error("Missing submit handler");
	await submit();
	expect(status.textContent).toContain(`Stage: ${stage}`);
	expect(status.textContent).toContain(hint);
	expect(status.textContent).not.toContain("private-");
	expect(button.disabled).toBe(false);
	expect(requests).toHaveLength(scenario === "verify" ? 2 : 1);
	if (scenario === "create" || scenario === "get") {
		expect(status.textContent).toContain(requestId);
		expect(progress[0]).toContain("Waiting for your browser");
		expect(status.textContent).toContain("not visible to the server");
	}
});

it("returns to a safe requested page after sign-in or standalone setup", async () => {
	const run = async (search: string, setup = false) => {
		const status = { textContent: "" },
			button = { disabled: false };
		let submit: (() => Promise<void>) | undefined;
		let assigned = "";
		class Assertion {
			clientDataJSON = new Uint8Array([1]).buffer;
			authenticatorData = new Uint8Array([2]).buffer;
			signature = new Uint8Array([3]).buffer;
		}
		const credential = {
			id: "credential",
			rawId: new Uint8Array([4]).buffer,
			type: "public-key",
			getClientExtensionResults: () => ({}),
			response: new Assertion(),
		};
		runInNewContext(authClient, {
			document: {
				querySelectorAll: () => [],
				getElementById: (id: string) =>
					id === "status"
						? status
						: id === "code"
							? { value: "setup-code" }
							: id !== "auth"
								? null
								: {
										dataset: { mode: setup ? "setup" : "login" },
										querySelector: () => button,
										addEventListener: (
											_name: string,
											callback: (event: { preventDefault: () => void }) => Promise<void>,
										) => {
											submit = () => callback({ preventDefault: () => {} });
										},
									},
			},
			window: {
				isSecureContext: true,
				location: {
					origin: "https://comms.test",
					search,
					hash: "",
					assign: (value: string) => {
						assigned = value;
					},
				},
			},
			navigator: { credentials: { get: async () => credential, create: async () => credential } },
			AuthenticatorAttestationResponse: class {},
			URL,
			URLSearchParams,
			atob,
			btoa,
			Uint8Array,
			fetch: async () =>
				Response.json(
					{ id: "challenge", options: { challenge: "YWJj", user: { id: "YWJj" } } },
					{ headers: { [requestIdHeader]: "1234567890abcdef1234567890abcdef" } },
				),
		});
		if (!submit) throw new Error("Missing submit handler");
		await submit();
		return assigned;
	};
	expect(await run("?next=/t/design")).toBe("/t/design");
	expect(await run("?next=https://evil.example")).toBe("/");
	expect(await run("?next=//evil.example")).toBe("/");
	expect(await run("")).toBe("/");
	expect(await run("?next=/\\evil.example")).toBe("/");
	// A dot segment collapses into a protocol-relative path once parsed.
	expect(await run("?next=/.//evil.example")).toBe("/");
	// Setup signs the human in, so it goes straight to the requested page too.
	expect(await run("?next=/t/design", true)).toBe("/t/design");
	expect(await run("?next=//evil.example", true)).toBe("/");
	expect(await run("", true)).toBe("/");
});

it("fills in a setup code from the fragment, clears it, and shows offered identities as text", async () => {
	const status = { textContent: "" },
		button = { disabled: false },
		code = { value: "" };
	let submit: (() => Promise<void>) | undefined;
	const replaced: string[] = [];
	const shown: string[] = [];
	const requests: { path: string; body: unknown }[] = [];
	let assigned = "";
	class Attestation {
		clientDataJSON = new Uint8Array([1]).buffer;
		attestationObject = new Uint8Array([2]).buffer;
	}
	const label = '<img src=x onerror="alert(1)">';
	runInNewContext(authClient, {
		document: {
			querySelectorAll: () => [],
			getElementById: (id: string) =>
				id === "status"
					? status
					: id === "code"
						? code
						: {
								dataset: { mode: "setup" },
								querySelector: () => button,
								addEventListener: (
									_name: string,
									callback: (event: { preventDefault: () => void }) => Promise<void>,
								) => {
									submit = () => callback({ preventDefault: () => {} });
								},
							},
		},
		window: {
			isSecureContext: true,
			location: {
				origin: "https://comms.test",
				pathname: "/setup",
				search: "",
				hash: "#code=0123456789ABCDEF",
				assign: (value: string) => {
					assigned = value;
				},
			},
		},
		history: {
			replaceState: (_state: unknown, _title: string, url: string) => {
				replaced.push(url);
			},
		},
		navigator: {
			credentials: {
				create: async () => {
					shown.push(status.textContent);
					return {
						id: "credential",
						rawId: new Uint8Array([3]).buffer,
						type: "public-key",
						getClientExtensionResults: () => ({}),
						response: new Attestation(),
					};
				},
			},
		},
		AuthenticatorAttestationResponse: Attestation,
		URL,
		URLSearchParams,
		atob,
		btoa,
		Uint8Array,
		fetch: async (path: string, init: RequestInit) => {
			requests.push({ path, body: JSON.parse(String(init.body)) });
			return path.endsWith("/options")
				? Response.json({
						id: "challenge",
						options: { challenge: "YWJj", user: { id: "YWJj" } },
						identities: [
							{ provider: "github", label },
							{ provider: "gitlab", label: "not offered by boot" },
						],
					})
				: Response.json({ expires_at: 1 });
		},
	});
	// The code is in the field and gone from the address before anything else happens.
	expect(code.value).toBe("0123456789ABCDEF");
	expect(replaced).toEqual(["/setup"]);
	if (!submit) throw new Error("Missing submit handler");
	await submit();
	expect(requests.map((request) => request.path)).toEqual(["/_boot/auth/setup/options", "/_boot/auth/setup/verify"]);
	expect(requests[0]?.body).toEqual({ code: "0123456789ABCDEF" });
	// Shown while the browser creates the passkey, as text: the status line is only ever written with textContent.
	expect(shown).toEqual([
		`Waiting for your browser to create a passkey… It will also link your GitHub account ${label}.`,
	]);
	expect(authClient).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
	expect(assigned).toBe("/");
});

it("starts a rendered provider's sign-in from ?provider=, unless the browser is already signed in", async () => {
	const run = async (search: string, authenticated: boolean | "unreachable", rendered = ["github"]) => {
		const status = { textContent: "" };
		const requests: string[] = [];
		const replaced: string[] = [];
		let assigned = "";
		runInNewContext(authClient, {
			document: {
				querySelectorAll: (selector: string) =>
					selector === "button[data-provider]"
						? rendered.map((provider) => ({ disabled: false, dataset: { provider }, addEventListener: () => {} }))
						: [],
				getElementById: (id: string) =>
					id === "status"
						? status
						: id === "auth"
							? { dataset: { mode: "login" }, querySelector: () => ({ disabled: false }), addEventListener: () => {} }
							: null,
			},
			window: {
				isSecureContext: true,
				location: {
					origin: "https://comms.test",
					pathname: "/auth/login",
					search,
					hash: "",
					assign: (value: string) => {
						assigned = value;
					},
				},
			},
			history: {
				replaceState: (_state: unknown, _title: string, url: string) => {
					replaced.push(url);
				},
			},
			URL,
			URLSearchParams,
			fetch: async (path: string) => {
				requests.push(path);
				if (path === "/_boot/auth/state") {
					if (authenticated === "unreachable") throw new Error("offline");
					return Response.json({ setup_required: false, authenticated });
				}
				return Response.json({ authorization_url: "https://auth.chirp.wiki/authorize?state=x" });
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		return { assigned, requests, replaced };
	};
	expect(await run("?provider=github&next=/t/design", false)).toEqual({
		assigned: "https://auth.chirp.wiki/authorize?state=x",
		requests: ["/_boot/auth/state", "/_boot/auth/oidc/start"],
		replaced: ["/auth/login?next=%2Ft%2Fdesign"],
	});
	// Already signed in: straight to the requested page, by the same same-origin rule as sign-in.
	expect(await run("?provider=github&next=/t/design", true)).toEqual({
		assigned: "/t/design",
		requests: ["/_boot/auth/state"],
		replaced: ["/auth/login?next=%2Ft%2Fdesign"],
	});
	expect((await run("?provider=github&next=//evil.example", true)).assigned).toBe("/");
	// Only a provider whose button the page rendered starts, and nothing starts when boot cannot be asked.
	for (const [search, rendered] of [
		["?provider=google", ["github"]],
		["?provider=github", []],
		["?provider=__proto__", ["github"]],
		["?next=/", ["github"]],
	] as const)
		expect(await run(search, false, [...rendered])).toEqual({ assigned: "", requests: [], replaced: [] });
	expect((await run("?provider=github", "unreachable")).assigned).toBe("");
	expect((await run("?provider=github", "unreachable")).requests).toEqual(["/_boot/auth/state"]);
});

it("offers only linked providers, and starts their sign-in with JSON before navigating itself", async () => {
	expect(authPage("login", ["github"])).toContain('data-provider="github">Continue with GitHub');
	expect(authPage("login", ["github"])).not.toContain("google");
	expect(authPage("login", ["github"])).toContain("Use your passkey, or the GitHub account you linked, to sign in");
	expect(authPage("login")).toContain("Use your passkey to sign in to your board.");
	expect(authPage("login")).not.toContain("data-provider");
	expect(authPage("setup", ["github"])).not.toContain("data-provider");
	const run = async (response: Response) => {
		const status = { textContent: "" };
		const choice = { disabled: false, dataset: { provider: "github" }, click: async () => {} };
		const choiceListener = (_name: string, callback: () => Promise<void>) => {
			choice.click = callback;
		};
		const requests: { path: string; body: unknown }[] = [];
		let assigned = "";
		runInNewContext(authClient, {
			document: {
				querySelectorAll: (selector: string) =>
					selector === "button[data-provider]" ? [{ ...choice, addEventListener: choiceListener }] : [],
				getElementById: (id: string) =>
					id === "status"
						? status
						: id === "auth"
							? { dataset: { mode: "login" }, querySelector: () => ({ disabled: false }), addEventListener: () => {} }
							: null,
			},
			window: {
				isSecureContext: true,
				location: {
					origin: "https://comms.test",
					search: "?next=/t/design",
					assign: (value: string) => {
						assigned = value;
					},
				},
			},
			URL,
			URLSearchParams,
			fetch: async (path: string, init: RequestInit) => {
				requests.push({ path, body: JSON.parse(String(init.body)) });
				expect(init.redirect).toBe("manual");
				return response;
			},
		});
		await choice.click();
		return { assigned, requests, status: status.textContent };
	};
	const started = await run(Response.json({ authorization_url: "https://auth.chirp.wiki/authorize?state=x" }));
	expect(started.assigned).toBe("https://auth.chirp.wiki/authorize?state=x");
	expect(started.requests).toEqual([
		{ path: "/_boot/auth/oidc/start", body: { intent: "login", provider: "github", next: "/t/design" } },
	]);
	const stalled = await run(Response.json({ error: { code: "oidc_unavailable" } }, { status: 503 }));
	expect(stalled.assigned).toBe("");
	expect(stalled.status).toContain("Sign in with your passkey");
	const unlinked = await run(Response.json({ error: { code: "identity_not_linked" } }, { status: 403 }));
	expect(unlinked.status).toBe("That account is no longer linked to this board. Sign in with your passkey.");
	const elsewhere = await run(Response.json({ authorization_url: "javascript:alert(1)" }));
	expect(elsewhere.assigned).toBe("");
});
