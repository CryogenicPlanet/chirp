import { BlockList, isIP } from "node:net";

/** Globally routable unicast only, per the IANA special-purpose registries; IPv4-mapped IPv6 is refused. */
export const makeAddressPolicy = () => {
	const reserved = new BlockList();
	for (const [network, prefix] of [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.88.99.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 3],
	] as const)
		reserved.addSubnet(network, prefix, "ipv4");
	for (const [network, prefix] of [
		["2001::", 23],
		["2001:db8::", 32],
		["2002::", 16],
		["3fff::", 20],
	] as const)
		reserved.addSubnet(network, prefix, "ipv6");
	const global = new BlockList();
	global.addSubnet("2000::", 3, "ipv6");
	return (address: string) => {
		const family = isIP(address);
		if (family === 4) return !reserved.check(address, "ipv4");
		return family === 6 && global.check(address, "ipv6") && !reserved.check(address, "ipv6");
	};
};
