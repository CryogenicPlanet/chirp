// oxlint-disable-next-line effecttsgo/node-builtin-import -- Constant-time comparison is not exposed by Effect Crypto.
import { timingSafeEqual } from "node:crypto";
import { Option } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import type { Attempt } from "./event-http.ts";
import type { Destination } from "./traffic.ts";

/** The attempt whose per-launch secret this request presents, with boot's own Host and no proxy headers. */
export const channelAttempt = (request: HttpServerRequest.HttpServerRequest, attempts: readonly Attempt[]) => {
	const supplied = Buffer.from(request.headers["x-boot-secret"] ?? "");
	const attempt =
		attempts.find((item) => {
			const value = Buffer.from(item.secret);
			return value.length === supplied.length && timingSafeEqual(value, supplied);
		}) ?? null;
	const expected = Buffer.from(attempt?.secret ?? "");
	if (
		!attempt ||
		supplied.length !== expected.length ||
		!timingSafeEqual(supplied, expected) ||
		request.headers.host !== attempt.host ||
		Object.keys(request.headers).some((key) => key.startsWith("x-forwarded-") || key === "forwarded")
	)
		return null;
	return attempt;
};

/** IPv4 127/8 and IPv6 ::1, including the IPv4-mapped form a dual-stack listener reports. */
export const loopback = (address: string) => {
	const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
	return bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
};

/**
 * Grants act for a human-approved agent, so they need more than a known secret: the attempt must be the one
 * the public route serves, fully live, and the caller must be on this host. A rehearsal is never recorded in
 * attempts; a starting or accepted candidate, a prior generation after the route switch and a retired child
 * are all refused here.
 */
export const liveChannelAttempt = (
	request: HttpServerRequest.HttpServerRequest,
	attempts: readonly Attempt[],
	route: Destination | null,
) => {
	const attempt = channelAttempt(request, attempts);
	if (
		!attempt ||
		attempt.state !== "live" ||
		route === null ||
		route.state !== "live" ||
		route.epoch !== attempt.epoch ||
		!Option.exists(request.remoteAddress, loopback)
	)
		return null;
	return attempt;
};
