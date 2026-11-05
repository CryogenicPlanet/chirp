import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import { createContext, useContext, useState, type ReactNode } from "react";
import { accountRequest, getFamilies } from "./account-api.ts";
import { useBoardClient } from "./board-client.tsx";
import type { Directory } from "./mentions.ts";
import { useLoad } from "./use-load.ts";

const hidden: ReadonlySet<string> = new Set(["system", "boot"]);

/** Optional: an extension may serve custom mention names that its agents or hooks answer to. */
const CustomMentions = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			mention: Schema.String.check(Schema.isPattern(/^@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)),
			description: Schema.optionalKey(Schema.String),
		}),
	),
});
const getCustomMentions = () =>
	accountRequest(HttpClientRequest.get(new URL("/api/mentions", window.location.origin).href)).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(CustomMentions)),
		Effect.map((list) => list.items.map((item) => ({ mention: item.mention, description: item.description ?? "" }))),
		Effect.orElseSucceed(() => []),
	);

const DirectoryContext = createContext<Directory | null>(null);

/**
 * Loads who can be mentioned once per board view: token families (agents and MCP
 * connections alike) give names and labels, and an optional extension route adds custom names. Post activity is
 * left out: on a big board it is a heavy aggregate, and this loads on every view. Any source may be missing; until all settle the
 * directory is null and mentions render plainly.
 */
export function DirectoryProvider({ children }: { readonly children: ReactNode }) {
	const client = useBoardClient();
	const [request] = useState(() =>
		client.identityBound(
			Effect.all(
				{
					families: getFamilies().pipe(
						Effect.map((list) => list.items),
						Effect.orElseSucceed(() => []),
					),
					custom: getCustomMentions(),
					me: client.read(client.me).pipe(Effect.option),
				},
				{ concurrency: "unbounded" },
			).pipe(
				Effect.map(({ families, custom, me }): Directory => {
					const self = me._tag === "Some" && me.value.kind === "human" ? me.value.agent : undefined;
					const live = families.filter((family) => !family.revoked);
					const names = [...new Set([...live.map((family) => family.agent), ...(self === undefined ? [] : [self])])]
						.filter((name) => !hidden.has(name))
						.sort((a, b) => a.localeCompare(b));
					return {
						self: self ?? null,
						custom: custom.filter((item) => item.mention !== "@here"),
						agents: names.map((name) => ({
							name,
							labels: [...new Set(live.filter((family) => family.agent === name).map((family) => family.label))].sort(),
						})),
					};
				}),
			),
		),
	);
	const { value } = useLoad(request);
	return <DirectoryContext.Provider value={value ?? null}>{children}</DirectoryContext.Provider>;
}

export const useDirectory = () => useContext(DirectoryContext);
