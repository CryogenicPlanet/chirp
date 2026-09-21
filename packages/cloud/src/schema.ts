import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	customType,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import type { DeploymentState } from "./deployment.ts";
import type { ProviderMutation } from "./operation.ts";

const storageEngines = ["sqlite", "postgres", "mysql"] as const;
const operationKinds = ["provision", "backup", "delete"] as const;
const operationStates = ["queued", "running", "succeeded", "failed"] as const;
const cCollatedChar = customType<{
	data: string;
	config: { readonly length: number };
	configRequired: true;
}>({
	dataType: ({ length }) => `char(${length}) COLLATE "C"`,
});

const cCollatedSlug = customType<{ data: string }>({
	dataType: () => 'varchar(32) COLLATE "C"',
});

export const cloudMigrations = pgTable("cloud_migrations", {
	migration_id: integer().primaryKey(),
	name: text().notNull(),
	compatible_schema_versions: integer()
		.array()
		.notNull()
		.default(sql`'{}'::integer[]`),
	created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const boards = pgTable(
	"boards",
	{
		id: uuid().primaryKey(),
		owner_id: text().notNull(),
		name: text().notNull(),
		slug: cCollatedSlug().notNull(),
		storage_engine: text({ enum: storageEngines }).notNull(),
		deletion_requested_at: timestamp({ withTimezone: true }),
		deleted_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("boards_slug_unique").on(table.slug),
		check("boards_name_nonempty", sql`length(btrim(${table.name})) > 0`),
		check("boards_slug_dns", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' AND ${table.slug} !~ '^xn--'`),
		check("boards_storage_engine_check", sql`${table.storage_engine} IN ('sqlite', 'postgres', 'mysql')`),
		index("boards_owner_created").on(table.owner_id, table.created_at.desc(), table.id.desc()),
	],
);

export const boardOperations = pgTable(
	"board_operations",
	{
		id: uuid().primaryKey(),
		board_id: uuid()
			.notNull()
			.references(() => boards.id, { onDelete: "restrict" }),
		kind: text({ enum: operationKinds }).notNull(),
		state: text({ enum: operationStates }).notNull(),
		checkpoint: text().notNull().default("requested"),
		requested_by: text().notNull(),
		idempotency_key: text().notNull(),
		request_hash: cCollatedChar({ length: 64 }).notNull(),
		available_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		attempt: integer().notNull().default(0),
		failure_count: integer().notNull().default(0),
		lease_token: uuid(),
		lease_owner: text(),
		lease_expires_at: timestamp({ withTimezone: true }),
		last_error_code: varchar({ length: 64 }),
		last_error_message: varchar({ length: 2_000 }),
		ambiguous_mutations: text()
			.$type<ProviderMutation>()
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		finished_at: timestamp({ withTimezone: true }),
	},
	(table) => [
		unique("board_operations_request_unique").on(table.requested_by, table.idempotency_key),
		check(
			"board_operations_kind_check",
			sql`${table.kind} IN ('provision', 'start', 'stop', 'restart', 'backup', 'delete')`,
		),
		check("board_operations_state_check", sql`${table.state} IN ('queued', 'running', 'succeeded', 'failed')`),
		check("board_operations_request_hash_hex", sql`${table.request_hash} ~ '^[0-9a-f]{64}$'`),
		check("board_operations_attempt_nonnegative", sql`${table.attempt} >= 0`),
		check("board_operations_failure_count_nonnegative", sql`${table.failure_count} >= 0`),
		check(
			"board_operations_ambiguous_mutations_known",
			sql`array_position(${table.ambiguous_mutations}, NULL) IS NULL AND ${table.ambiguous_mutations} <@ ARRAY[
				'app_create', 'volume_create', 'machine_create', 'machine_start',
				'edge_ip', 'edge_certificate', 'edge_a_record', 'edge_txt_record'
			]::text[]`,
		),
		check(
			"board_operations_lease_shape",
			sql`(
				(${table.state} = 'running' AND ${table.lease_token} IS NOT NULL AND ${table.lease_owner} IS NOT NULL AND ${table.lease_expires_at} IS NOT NULL)
				OR (${table.state} <> 'running' AND ${table.lease_token} IS NULL AND ${table.lease_owner} IS NULL AND ${table.lease_expires_at} IS NULL)
			)`,
		),
		check(
			"board_operations_finished_shape",
			sql`(
				(${table.state} IN ('succeeded', 'failed') AND ${table.finished_at} IS NOT NULL)
				OR (${table.state} IN ('queued', 'running') AND ${table.finished_at} IS NULL)
			)`,
		),
		uniqueIndex("board_operations_active_board")
			.on(table.board_id)
			.where(sql`${table.state} IN ('queued', 'running')`),
		index("board_operations_queue").on(table.state, table.available_at, table.created_at, table.id),
	],
);

export const boardDeployments = pgTable("board_deployments", {
	board_id: uuid()
		.primaryKey()
		.references(() => boards.id, { onDelete: "restrict" }),
	state: text().$type<DeploymentState>().notNull(),
	row_version: integer().notNull().default(0),
	hostname: text().notNull().unique(),
	storage_engine: text({ enum: storageEngines }).notNull(),
	region: text().notNull(),
	image_ref: text().notNull(),
	app_name: text().notNull().unique(),
	network_name: text().notNull(),
	volume_name: text().notNull(),
	machine_name: text().notNull(),
	volume_size_gb: integer().notNull(),
	app_id: text(),
	volume_id: text().unique(),
	machine_id: text().unique(),
	last_snapshot_id: text(),
	last_snapshot_created_at: timestamp({ withTimezone: true }),
	last_snapshot_digest: text(),
	last_snapshot_retention_days: integer(),
	created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
	updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const boardRoutes = pgTable("board_routes", {
	hostname: text().primaryKey(),
	board_id: uuid()
		.notNull()
		.unique()
		.references(() => boardDeployments.board_id, { onDelete: "restrict" }),
	app_name: text().notNull(),
	created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const boardPostgresSecrets = pgTable(
	"board_postgres_secrets",
	{
		board_id: uuid()
			.primaryKey()
			.references(() => boards.id, { onDelete: "restrict" }),
		bootstrap_ciphertext: text(),
		runtime_ciphertext: text(),
		prepared: boolean().notNull().default(false),
		fly_secrets_version: integer(),
	},
	(table) => [
		check(
			"board_postgres_secrets_stage_check",
			sql`(
				(NOT ${table.prepared} AND ${table.bootstrap_ciphertext} IS NOT NULL AND ${table.runtime_ciphertext} IS NULL)
				OR (${table.prepared} AND ${table.bootstrap_ciphertext} IS NULL AND ${table.runtime_ciphertext} IS NOT NULL)
			)`,
		),
	],
);
