import { allExtensionsIngressProtocolVersion, ingressProtocolVersion } from "@comms/protocol/headers";
import { Config, Effect, Option, Schema } from "effect";

/** Whose application-managed routes anonymous traffic may reach: every extension's, none, or the named ones'. */
export const IngressSetting = Schema.Union([Schema.Boolean, Schema.Array(Schema.String)]);
export type IngressSetting = typeof IngressSetting.Type;
/** The JSON encoding boot sends; the dispatcher echoes what it enforces in the same form for boot to compare. */
export const encodeIngressSetting = Schema.encodeSync(Schema.fromJsonString(IngressSetting));

/** What boot tells the app about its board. */
export interface BoardSettings {
	/** The board's primary public origin; undefined under a boot that does not name it. */
	readonly origin: string | undefined;
	readonly ingress: IngressSetting;
}

/**
 * The board's human, whose name no agent or extension may post as. Boot sends BOARD_OWNER at each launch as a JSON
 * string, or null until first setup names the human, so a board named after this child started reserves the name from
 * its next launch. A boot that sends none predates naming and calls its human rahul. An unreadable value names nobody.
 */
export const boardOwner: Effect.Effect<string | null, Config.ConfigError> = Effect.gen(function* () {
	const value = yield* Config.option(Config.String("BOARD_OWNER"));
	if (Option.isNone(value)) return "rahul";
	return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.NullOr(Schema.String)))(value.value).pipe(
		Effect.orElseSucceed(() => null),
	);
});

/**
 * Reads BOARD_ORIGIN and APPLICATION_MANAGED_INGRESS from the environment boot gives the app. An unreadable setting
 * admits nothing. A boot that sends no setting predates it: it forwards anonymous traffic only when its operator allows
 * every extension, and only to a kernel advertising the all-extensions protocol, so that is what this kernel offers it.
 */
export const boardSettings: Effect.Effect<
	{ readonly board: BoardSettings; readonly ingressProtocol: string },
	Config.ConfigError
> = Effect.gen(function* () {
	const origin = Option.getOrUndefined(yield* Config.option(Config.String("BOARD_ORIGIN")));
	const setting = yield* Config.option(Config.String("APPLICATION_MANAGED_INGRESS"));
	if (Option.isNone(setting))
		return { board: { origin, ingress: true }, ingressProtocol: allExtensionsIngressProtocolVersion };
	const ingress = yield* Schema.decodeEffect(Schema.fromJsonString(IngressSetting))(setting.value).pipe(
		Effect.orElseSucceed((): IngressSetting => false),
	);
	return { board: { origin, ingress }, ingressProtocol: ingressProtocolVersion };
});
