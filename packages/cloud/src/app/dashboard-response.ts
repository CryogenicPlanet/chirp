import { Schema } from "effect";

class DashboardResponseError extends Error {}

const unavailable = "Chirp Cloud is temporarily unavailable.";
const errorResponse = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });

export const readDashboardResponse = async <A, I>(response: Response, schema: Schema.Codec<A, I>): Promise<A> => {
	try {
		if (!response.ok) {
			if (response.status === 401) throw new DashboardResponseError("Your session expired. Sign in again to continue.");
			if (response.status === 404) throw new DashboardResponseError("This board was not found.");
			if (response.status === 409)
				throw new DashboardResponseError("That request key was already used for different board details.");
			if (response.status === 403) {
				const body = Schema.decodeUnknownSync(errorResponse)(await response.json());
				if (body.error.code === "board_quota_exceeded")
					throw new DashboardResponseError("Your account has reached its board limit. Contact support for help.");
				throw new DashboardResponseError("This page could not be verified. Reload Chirp Cloud and try again.");
			}
			throw new DashboardResponseError(response.status >= 500 ? unavailable : "Check the board name and try again.");
		}
		return Schema.decodeUnknownSync(schema)(await response.json());
	} catch (cause) {
		if (cause instanceof DashboardResponseError) throw cause;
		throw new DashboardResponseError(unavailable);
	}
};

export const dashboardErrorMessage = (cause: unknown) =>
	cause instanceof DashboardResponseError ? cause.message : unavailable;
