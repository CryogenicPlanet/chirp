import { isIP } from "node:net";

export const isIpv4BindAddress = (address: string) => isIP(address) === 4;

export const isProxyTransport = (remoteAddress: string | undefined) =>
	remoteAddress !== undefined && isIP(remoteAddress) === 4;

export const hasAuthoritativeClientIp = (headers: Headers, headerName: string) => {
	const value = headers.get(headerName)?.trim();
	return value !== undefined && !value.includes(",") && !value.includes("%") && isIP(value) !== 0;
};
