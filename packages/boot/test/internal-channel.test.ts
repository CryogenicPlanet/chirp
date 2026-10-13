import { Option } from "effect";
import { Headers, HttpServerRequest } from "effect/unstable/http";
import { expect, it } from "vitest";
import type { Attempt } from "../src/event-http.ts";
import { channelAttempt, liveChannelAttempt, loopback } from "../src/internal-channel.ts";
import type { Destination } from "../src/traffic.ts";

const host = "127.0.0.1:4100";
const attempt = (secret: string, epoch: string, state: Attempt["state"]): Attempt => ({
	secret: secret.repeat(64),
	epoch,
	host,
	generation: 1,
	state,
});
const route = (value: Attempt): Destination => ({ ...value, port: 4200, pid: 1, snapshot: "/gen/1" });
const request = (
	secret: string,
	headers: Readonly<Record<string, string>> = {},
	address: string | null = "127.0.0.1",
) =>
	HttpServerRequest.fromWeb(
		new Request(`http://${host}/api/messages`, { headers: { host, "x-boot-secret": secret.repeat(64), ...headers } }),
	).modify({ remoteAddress: Option.fromNullishOr(address) });

it("admits a grant only from the live attempt the public route serves, on loopback", () => {
	const live = attempt("a", "live", "live");
	const prior = attempt("b", "prior", "live");
	const starting = attempt("c", "starting", "starting");
	const accepted = attempt("d", "accepted", "accepted");
	const attempts = [live, prior, starting, accepted];
	expect(liveChannelAttempt(request("a"), attempts, route(live))).toEqual(live);
	// A prior generation stays recorded as live until retirement, but the route has already switched.
	expect(liveChannelAttempt(request("b"), attempts, route(live))).toBeNull();
	expect(liveChannelAttempt(request("c"), attempts, route(live))).toBeNull();
	expect(liveChannelAttempt(request("d"), attempts, route(live))).toBeNull();
	// During the accepted window the route names the candidate, which is not yet live.
	expect(liveChannelAttempt(request("d"), attempts, { ...route(accepted), state: "accepted" })).toBeNull();
	expect(liveChannelAttempt(request("a"), attempts, { ...route(accepted), state: "accepted" })).toBeNull();
	// Retired children are removed from attempts; rehearsals are never recorded there.
	expect(liveChannelAttempt(request("e"), attempts, route(live))).toBeNull();
	expect(liveChannelAttempt(request("a"), [prior], route(live))).toBeNull();
	expect(liveChannelAttempt(request("a"), attempts, null)).toBeNull();
	// A withdrawn or replaced route refuses even the attempt that is still recorded live.
	expect(liveChannelAttempt(request("a"), attempts, route(prior))).toBeNull();
	for (const address of ["10.0.0.2", "192.168.1.4", "::ffff:10.0.0.2", "fe80::1", null])
		expect(liveChannelAttempt(request("a", {}, address), attempts, route(live))).toBeNull();
	for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
		expect(liveChannelAttempt(request("a", {}, address), attempts, route(live))).toEqual(live);
});

it("keeps the existing channel checks: constant secret, exact host and no proxy headers", () => {
	const live = attempt("a", "live", "live");
	expect(channelAttempt(request("a"), [live])).toEqual(live);
	expect(channelAttempt(request("a", { host: "comms.test" }), [live])).toBeNull();
	expect(channelAttempt(request("a", { "x-forwarded-for": "10.0.0.1" }), [live])).toBeNull();
	expect(channelAttempt(request("a", { forwarded: "for=10.0.0.1" }), [live])).toBeNull();
	expect(
		channelAttempt(HttpServerRequest.fromWeb(new Request(`http://${host}/x`, { headers: { host } })), [live]),
	).toBeNull();
	expect(
		channelAttempt(request("a").modify({ headers: Headers.fromInput({ host, "x-boot-secret": "a".repeat(63) }) }), [
			live,
		]),
	).toBeNull();
	// The channel itself does not look at the address; grants add that check.
	expect(channelAttempt(request("a", {}, "10.0.0.2"), [live])).toEqual(live);
});

it("recognizes loopback addresses only", () => {
	expect(["127.0.0.1", "127.255.0.1", "::1", "::ffff:127.0.0.1"].every(loopback)).toBe(true);
	expect(
		["0.0.0.0", "10.0.0.1", "128.0.0.1", "::", "::ffff:10.0.0.1", "localhost", "127.0.0.1.evil"].some(loopback),
	).toBe(false);
});
