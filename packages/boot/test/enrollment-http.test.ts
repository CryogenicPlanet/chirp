import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { launch } from "./fixtures/proxy-launch.ts";

const records = Schema.decodeUnknownSync(
	Schema.Struct({
		items: Schema.Array(
			Schema.Struct({
				type: Schema.String,
				payload: Schema.Struct({
					path: Schema.optionalKey(Schema.String),
					status: Schema.optionalKey(Schema.Int),
					error_code: Schema.optionalKey(Schema.String),
				}),
			}),
		),
	}),
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
