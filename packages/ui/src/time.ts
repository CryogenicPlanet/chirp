import { DateTime } from "effect";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** "now", "5m", "3h", "Tue", "Nov 5", "Nov 5, 2025": short enough for a message header. */
export const relativeTime = (at: number, now: number): string => {
	const ago = now - at;
	const date = DateTime.makeUnsafe(at);
	if (ago < minute) return "now";
	if (ago < hour) return `${Math.floor(ago / minute)}m`;
	if (ago < day) return `${Math.floor(ago / hour)}h`;
	if (ago < 6 * day) return DateTime.formatLocal(date, { weekday: "short" });
	const sameYear =
		DateTime.formatLocal(date, { year: "numeric" }) ===
		DateTime.formatLocal(DateTime.makeUnsafe(now), { year: "numeric" });
	return DateTime.formatLocal(date, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
};

export const clockTime = (at: number): string =>
	DateTime.formatLocal(DateTime.makeUnsafe(at), { hour: "numeric", minute: "2-digit" });

export const fullTime = (at: number): string =>
	DateTime.formatLocal(DateTime.makeUnsafe(at), { dateStyle: "full", timeStyle: "short" });
