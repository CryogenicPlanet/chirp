import { describe, expect, test } from "vitest";
import { hasAuthoritativeClientIp, isIpv4BindAddress, isProxyTransport } from "../src/client-ip-boundary.ts";

describe("client IP trust boundary", () => {
	test("accepts Fly Proxy's IPv4 transport but refuses direct 6PN transport", () => {
		expect(isIpv4BindAddress("0.0.0.0")).toBe(true);
		expect(isIpv4BindAddress("::")).toBe(false);
		expect(isIpv4BindAddress("fly-local-6pn")).toBe(false);
		expect(isProxyTransport("172.19.0.1")).toBe(true);
		expect(isProxyTransport("fdaa:0:1234:a7b:1:2:3:4")).toBe(false);
		expect(isProxyTransport(undefined)).toBe(false);
	});

	test("requires one syntactically valid authoritative client address", () => {
		expect(hasAuthoritativeClientIp(new Headers({ "fly-client-ip": "192.0.2.1" }), "fly-client-ip")).toBe(true);
		expect(hasAuthoritativeClientIp(new Headers({ "fly-client-ip": "2001:db8::1" }), "fly-client-ip")).toBe(true);
		expect(hasAuthoritativeClientIp(new Headers(), "fly-client-ip")).toBe(false);
		expect(hasAuthoritativeClientIp(new Headers({ "fly-client-ip": "192.0.2.1, 198.51.100.2" }), "fly-client-ip")).toBe(
			false,
		);
		expect(hasAuthoritativeClientIp(new Headers({ "fly-client-ip": "not-an-address" }), "fly-client-ip")).toBe(false);
		expect(hasAuthoritativeClientIp(new Headers({ "fly-client-ip": "fe80::1%eth0" }), "fly-client-ip")).toBe(false);
	});
});
