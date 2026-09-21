import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Effect, Data, Redacted } from "effect";
import { Client } from "pg";

export class PostgresBootstrapError extends Data.TaggedError("PostgresBootstrapError")<{
	readonly reason:
		| "invalid_url"
		| "unsafe_endpoint"
		| "unsupported_channel_binding"
		| "connection_failed"
		| "transient_failure"
		| "resource_conflict"
		| "bootstrap_failed";
}> {}

export interface PostgresBootstrapInput {
	readonly boardId: string;
	readonly adminUrl: Redacted.Redacted<string>;
	readonly bootPassword: Redacted.Redacted<string>;
	readonly appPassword: Redacted.Redacted<string>;
	readonly allowLocal?: boolean;
}

const invalid = () => new PostgresBootstrapError({ reason: "invalid_url" });
const transientCodes: ReadonlyArray<string> = [
	"40001",
	"40P01",
	"55P03",
	"57014",
	"57P01",
	"57P02",
	"57P03",
	"53300",
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
];
export const isTransientPostgresFailure = (cause: unknown) => {
	const code = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
	return (
		(typeof code === "string" && (code.startsWith("08") || transientCodes.some((candidate) => candidate === code))) ||
		(cause instanceof Error &&
			/(?:connection (?:ended|terminated)|query read timeout|socket hang up)/i.test(cause.message))
	);
};
const statementFailure = (cause: unknown) =>
	new PostgresBootstrapError({ reason: isTransientPostgresFailure(cause) ? "transient_failure" : "bootstrap_failed" });

export const isAllowedPostgresAddress = (address: string, allowLocal = false): boolean => {
	if (allowLocal && (address === "127.0.0.1" || address === "::1")) return true;
	// IPv4 only: refusing IPv6 also prevents IPv4-mapped and transition-address bypasses.
	if (isIP(address) !== 4) return false;
	const blocked = new BlockList();
	for (const [network, prefix] of [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	] as const)
		blocked.addSubnet(network, prefix);
	return !blocked.check(address);
};

export const firstAllowedPostgresAddress = (
	addresses: ReadonlyArray<{ readonly address: string }>,
	allowLocal = false,
) => addresses.find(({ address }) => isAllowedPostgresAddress(address, allowLocal))?.address;

export const validatePostgresUrl = (secret: Redacted.Redacted<string>, allowLocal = false) =>
	Effect.try({
		try: () => {
			const url = new URL(Redacted.value(secret));
			if (
				!["postgres:", "postgresql:"].includes(url.protocol) ||
				!url.username ||
				!url.password ||
				!url.hostname ||
				url.hash ||
				url.pathname.length < 2
			)
				throw invalid();
			decodeURIComponent(url.username);
			decodeURIComponent(url.password);
			decodeURIComponent(url.pathname);
			const keys = [...url.searchParams.keys()];
			if (new Set(keys).size !== keys.length || keys.some((key) => !["sslmode", "channel_binding"].includes(key)))
				throw invalid();
			const sslmode = url.searchParams.get("sslmode");
			if (sslmode !== null && !["require", "verify-full", ...(allowLocal ? ["disable"] : [])].includes(sslmode))
				throw invalid();
			const binding = url.searchParams.get("channel_binding");
			if (binding !== null && binding !== "require" && binding !== "prefer") throw invalid();
			// pg supports preferring channel binding, but cannot enforce libpq's require contract.
			if (binding === "require") throw new PostgresBootstrapError({ reason: "unsupported_channel_binding" });
			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			if (isIP(hostname) && !isAllowedPostgresAddress(hostname, allowLocal))
				throw new PostgresBootstrapError({ reason: "unsafe_endpoint" });
			if (
				!allowLocal &&
				(hostname === "localhost" ||
					hostname.endsWith(".localhost") ||
					hostname.endsWith(".local") ||
					hostname.endsWith(".internal"))
			)
				throw new PostgresBootstrapError({ reason: "unsafe_endpoint" });
			return { url, tls: sslmode !== "disable" };
		},
		catch: (error) => (error instanceof PostgresBootstrapError ? error : invalid()),
	});

export const derivePostgresUrls = (input: PostgresBootstrapInput) =>
	Effect.gen(function* () {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.boardId)) return yield* invalid();
		if (
			![input.bootPassword, input.appPassword].every((password) => /^[0-9a-f]{64}$/.test(Redacted.value(password))) ||
			Redacted.value(input.bootPassword) === Redacted.value(input.appPassword)
		)
			return yield* invalid();
		const { url, tls } = yield* validatePostgresUrl(input.adminUrl, input.allowLocal);
		const suffix = input.boardId.replaceAll("-", "").toLowerCase();
		const bootName = `chirp_${suffix}_boot`;
		const appName = `chirp_${suffix}_app`;
		const make = (name: string, password: Redacted.Redacted<string>) => {
			const output = new URL(url);
			output.username = name;
			output.password = Redacted.value(password);
			output.pathname = `/${name}`;
			output.search = "";
			return Redacted.make(output.toString());
		};
		return {
			bootUrl: make(bootName, input.bootPassword),
			appUrl: make(appName, input.appPassword),
			tls,
			bootName,
			appName,
		};
	});

export const bootstrapPostgres = (input: PostgresBootstrapInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const result = yield* derivePostgresUrls(input);
			const { url } = yield* validatePostgresUrl(input.adminUrl, input.allowLocal);
			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			const addresses = yield* Effect.tryPromise({
				try: () => lookup(hostname, { all: true }),
				catch: () => new PostgresBootstrapError({ reason: "connection_failed" }),
			});
			const address = firstAllowedPostgresAddress(addresses, input.allowLocal);
			if (!address) return yield* new PostgresBootstrapError({ reason: "unsafe_endpoint" });
			if (!result.tls && addresses.some(({ address }) => address !== "127.0.0.1" && address !== "::1"))
				return yield* new PostgresBootstrapError({ reason: "unsafe_endpoint" });
			const connect = (
				database: string,
				username = decodeURIComponent(url.username),
				password = Redacted.make(decodeURIComponent(url.password)),
			) =>
				Effect.acquireRelease(
					Effect.sync(
						() =>
							new Client({
								host: address,
								port: Number(url.port || 5432),
								database,
								user: username,
								password: Redacted.value(password),
								ssl: result.tls ? { rejectUnauthorized: true, servername: hostname } : false,
								enableChannelBinding: true,
								connectionTimeoutMillis: 10_000,
								query_timeout: 15_000,
								application_name: "chirp-cloud-bootstrap",
							}),
					),
					(client) => Effect.promise(() => client.end().catch(() => undefined)),
				).pipe(
					Effect.tap((client) =>
						Effect.tryPromise({
							try: () => client.connect(),
							catch: () => new PostgresBootstrapError({ reason: "connection_failed" }),
						}),
					),
				);
			const admin = yield* connect(decodeURIComponent(url.pathname.slice(1)));
			const run = (client: Client, statement: string, values: readonly string[] = []) =>
				Effect.tryPromise({
					try: () => client.query(statement, [...values]),
					catch: statementFailure,
				});
			// A dedicated connection holds this lock across nontransactional CREATE DATABASE calls.
			yield* run(admin, "SELECT pg_advisory_lock(hashtextextended($1, 0))", [`chirp-bootstrap:${input.boardId}`]);
			for (const [name, secret] of [
				[result.bootName, input.bootPassword],
				[result.appName, input.appPassword],
			] as const) {
				const password = Redacted.value(secret);
				if (
					!/^[0-9a-f]{64}$/.test(password) ||
					Redacted.value(input.bootPassword) === Redacted.value(input.appPassword)
				)
					return yield* invalid();
				const marker = createHmac("sha256", password).update(`chirp-bootstrap:${name}`).digest("hex");
				const rows = yield* Effect.tryPromise({
					try: () =>
						admin.query<{ marker: string | null; safe: boolean }>(
							"SELECT shobj_description(oid, 'pg_authid') AS marker, rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS safe FROM pg_roles WHERE rolname=$1",
							[name],
						),
					catch: statementFailure,
				});
				if (rows.rows.length) {
					if (rows.rows[0]?.marker !== marker || !rows.rows[0]?.safe)
						return yield* new PostgresBootstrapError({ reason: "resource_conflict" });
				} else {
					// Names, passwords and marker are constrained to generated ASCII, never user SQL.
					yield* run(
						admin,
						`BEGIN; CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; COMMENT ON ROLE "${name}" IS '${marker}'; COMMIT;`,
					);
				}
			}
			for (const name of [result.bootName, result.appName]) {
				const databases = yield* Effect.tryPromise({
					try: () =>
						admin.query<{ owner: string }>(
							"SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
							[name],
						),
					catch: statementFailure,
				});
				if (databases.rows.length && databases.rows[0]?.owner !== result.bootName)
					return yield* new PostgresBootstrapError({ reason: "resource_conflict" });
				if (!databases.rows.length)
					yield* run(admin, `CREATE DATABASE "${name}" OWNER "${result.bootName}" TEMPLATE template0 ENCODING 'UTF8'`);
				yield* run(admin, `REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
				if (name === result.appName)
					yield* run(admin, `GRANT CONNECT, TEMPORARY, CREATE ON DATABASE "${name}" TO "${result.appName}"`);
				const database = yield* connect(name);
				yield* run(
					database,
					`ALTER SCHEMA public OWNER TO "${result.bootName}"; REVOKE ALL ON SCHEMA public FROM PUBLIC`,
				);
				if (name === result.appName)
					yield* run(database, `GRANT USAGE, CREATE ON SCHEMA public TO "${result.appName}"`);
			}
			// Authenticate every supported login/database combination before releasing credentials.
			for (const [name, login, password] of [
				[result.bootName, result.bootName, input.bootPassword],
				[result.appName, result.bootName, input.bootPassword],
				[result.appName, result.appName, input.appPassword],
			] as const) {
				const client = yield* connect(name, login, password);
				yield* run(client, "SELECT 1");
			}
			const privileges = yield* Effect.tryPromise({
				try: () =>
					admin.query<{ denied: boolean }>("SELECT NOT has_database_privilege($1, $2, 'CONNECT') AS denied", [
						result.appName,
						result.bootName,
					]),
				catch: statementFailure,
			});
			if (!privileges.rows[0]?.denied) return yield* new PostgresBootstrapError({ reason: "resource_conflict" });
			return result;
		}).pipe(
			Effect.timeoutOrElse({
				duration: "60 seconds",
				orElse: () => Effect.fail(new PostgresBootstrapError({ reason: "connection_failed" })),
			}),
		),
	);
