import { assertionHeader } from "@comms/protocol/headers";
import { randomBytes } from "node:crypto";
import { DateTime, Schema } from "effect";
import { expect, it } from "vitest";
import { authenticator } from "./fixtures/authenticator.ts";
import { launch } from "./fixtures/proxy-launch.ts";

const records = Schema.decodeUnknownSync(
	Schema.Struct({
		items: Schema.Array(
			Schema.Struct({
				type: Schema.String,
				actor: Schema.String,
				instance: Schema.NullOr(Schema.String),
				payload: Schema.Struct({
					path: Schema.optionalKey(Schema.String),
					status: Schema.optionalKey(Schema.Int),
					error_code: Schema.optionalKey(Schema.String),
					id: Schema.optionalKey(Schema.String),
					agent: Schema.optionalKey(Schema.String),
					label: Schema.optionalKey(Schema.String),
					scopes: Schema.optionalKey(Schema.Array(Schema.String)),
				}),
			}),
		),
	}),
);
const ceremony = Schema.decodeUnknownSync(
	Schema.Struct({ id: Schema.String, options: Schema.Struct({ challenge: Schema.String }) }),
);

it("answers malformed and unknown approval links with a specific 404 that an agent can find in request records", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const id = `e_${randomBytes(32).toString("base64url")}`;
	const paths = [
		`/approve/${id}%60`,
		`/approve/${id}.`,
		`/approve/${id})`,
		`/approve/${id}'`,
		`/approve/${id}/`,
		`/approve/${id.slice(0, -1)}`,
		"/approve/",
		"/approve",
		`/_boot/approve/${id}.svg`,
		// Well formed, but no such enrollment.
		`/approve/${id}`,
		`/_boot/approve/${id}`,
	];
	for (const path of paths)
		for (const headers of [{}, { cookie: app.cookie }, { cookie: app.cookie, accept: "text/html" }]) {
			const response = await fetch(`${app.url}${path}`, { headers });
			expect(response.status, path).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toMatchObject({
				error: {
					code: "approval_link_invalid",
					hint: expect.stringContaining("without trailing characters such as a backtick"),
					retriable: false,
				},
			});
		}
	await expect
		.poll(async () =>
			records(await (await app.fetch(`${app.url}/_boot/events?limit=200`)).json())
				.items.filter((event) => event.type === "http.request")
				.find((event) => event.payload.path === `/approve/${id}%60`),
		)
		.toMatchObject({ payload: { status: 404, error_code: "approval_link_invalid" } });
}, 15000);

it("answers empty, malformed and non-POST enrollment polls with 404 enrollment_invalid, not a sign-in refusal", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const id = `e_${randomBytes(32).toString("base64url")}`;
	const polls = [
		// An id lost between shell commands leaves the path ending in a slash.
		["POST", "/auth/enroll/"],
		["POST", "/_boot/enroll/"],
		["POST", "/auth/enroll/undefined"],
		["POST", `/auth/enroll/${id.slice(0, -1)}`],
		["POST", `/auth/enroll/${id}%60`],
		["POST", `/auth/enroll/${id}/`],
		["POST", `/_boot/enroll/${id}/collect`],
		["GET", `/auth/enroll/${id}`],
		["PUT", `/_boot/enroll/${id}`],
		["DELETE", `/auth/enroll/${id}`],
	] as const;
	for (const [method, path] of polls)
		for (const credentials of [{}, { cookie: app.cookie }]) {
			const response = await fetch(`${app.url}${path}`, {
				method,
				headers: { ...credentials, "content-type": "application/json" },
				...(method === "GET" ? {} : { body: JSON.stringify({ device_secret: randomBytes(32).toString("base64url") }) }),
			});
			expect(response.status, `${method} ${path}`).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await response.json()).toMatchObject({
				error: {
					code: "enrollment_invalid",
					hint: expect.stringContaining("POST /auth/enroll/<id>"),
					retriable: false,
				},
			});
		}
	await expect
		.poll(async () =>
			records(await (await app.fetch(`${app.url}/_boot/events?limit=200`)).json())
				.items.filter((event) => event.type === "http.request")
				.find((event) => event.payload.path === "/auth/enroll/"),
		)
		.toMatchObject({ payload: { status: 404, error_code: "enrollment_invalid" } });
}, 15000);

it("shows a pending enrollment's expiry, and lists its approval and collection but never its creation", async (test) => {
	const app = await launch(test);
	await expect.poll(async () => (await app.state()).state).toBe("live");
	const device = authenticator();
	const post = (path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
		fetch(`${app.url}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://comms.test", ...headers },
			body: JSON.stringify(body),
		});
	const setupCode = () => /\/setup is open, code ([A-F0-9]+)/.exec(app.output())?.[1];
	await expect.poll(setupCode).toBeTruthy();
	const setup = ceremony(await (await post("/_boot/auth/setup/options", { code: setupCode() })).json());
	expect(
		(await post("/_boot/auth/setup/verify", { id: setup.id, response: device.registration(setup.options.challenge) }))
			.status,
	).toBe(200);
	const enrollmentEvents = async () =>
		records(await (await app.fetch(`${app.url}/_boot/events?limit=200`)).json()).items.filter((event) =>
			event.type.startsWith("enrollment."),
		);

	const created = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String, device_secret: Schema.String, expires_at: Schema.Int }),
	)(await (await post("/auth/enroll", { name: "muse", kind: "claude", host: "sandbox" })).json());
	const pending = await post(`/auth/enroll/${created.id}`, { device_secret: created.device_secret });
	expect(pending.status).toBe(202);
	expect(await pending.json()).toEqual({ status: "pending", expires_at: created.expires_at });
	expect(await (await fetch(`${app.url}/approve/${created.id}`)).text()).toContain(
		`expires at <time datetime="${DateTime.formatIso(DateTime.makeUnsafe(created.expires_at))}">`,
	);
	expect(await enrollmentEvents()).toEqual([]);

	const scopes = ["read", "write"];
	const challenge = ceremony(
		await (
			await post("/_boot/auth/challenge", {
				action: "enrollment.decide",
				params: { id: created.id, decision: "approve", scopes, long_lived: false },
			})
		).json(),
	);
	const proof = Buffer.from(
		JSON.stringify({ id: challenge.id, response: device.assertion(challenge.options.challenge, 1) }),
	).toString("base64url");
	expect(
		(
			await post(
				`/_boot/enroll/${created.id}/approve`,
				{ decision: "approve", scopes, long_lived: false },
				{ [assertionHeader]: proof },
			)
		).status,
	).toBe(200);
	const collected = await post(`/auth/enroll/${created.id}`, { device_secret: created.device_secret });
	expect(collected.status).toBe(200);
	const pair = Schema.decodeUnknownSync(
		Schema.Struct({ family: Schema.String, access: Schema.String, refresh: Schema.String }),
	)(await collected.json());
	const listed = await enrollmentEvents();
	expect(listed.map((event) => event.type)).toEqual(["enrollment.approved", "enrollment.collected"]);
	expect(listed[1]).toEqual({
		type: "enrollment.collected",
		actor: "muse",
		instance: pair.family,
		payload: { id: created.id, agent: "muse", label: "sandbox", scopes },
	});
	const text = await (await app.fetch(`${app.url}/_boot/events?limit=200`)).text();
	for (const secret of [created.device_secret, pair.access, pair.refresh]) expect(text).not.toContain(secret);
}, 20000);
