import { reservedIngressRoute, applicationCookiePrefix } from "@comms/protocol/headers";

/** Only explicitly namespaced application cookies cross the board credential boundary. */
export const applicationCookies = (header: string | undefined): string =>
	(header ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => new RegExp(`^${applicationCookiePrefix}[A-Za-z0-9_-]+=`, "u").test(part))
		.join("; ");

/** Encoded or aliased control paths must never enter editable routing. */
export const isReservedIngressPath = (pathname: string): boolean => {
	let path: string;
	try {
		path = new URL(
			`http://localhost${decodeURIComponent(pathname).replaceAll("\\", "/").replace(/\/+/g, "/")}`,
		).pathname.toLowerCase();
	} catch {
		return true;
	}
	return reservedIngressRoute(path);
};
