# @comms/boot

The stable host beneath the editable message board. Boot keeps authentication, source editing and recovery available when the app cannot start.

Run it through the server launcher with `bun run start` at the repository root. See the [project README](../../../README.md) for setup and [deploy guide](../../../docs/deploy.md) for container configuration.

## Recovery surfaces

- `/setup` and `/auth/login`: passkey registration and sign-in.
- `/_boot`: recovery help, independent of the app.
- `/_boot/status` and `/_boot/generations`: authenticated runtime and generation diagnostics.
- `/_boot/events`: authenticated boot lifecycle and request diagnostics.
- `/.well-known/agent.json`: the boot API manifest, including authentication requirements.

Use the [editing guide](../../server/pages/docs/editing.md) for locks, conditional file writes, reloads and source history. Source-only revert and seed reset preserve messages, pages and identities. Restoring a database is a separate, human-authorized action.

## Ownership

Boot owns the public listener, credentials, process supervision, source publication and the durable sequence/publication boundary. It owns SQLite file backup/restore; remote snapshots and restore belong to the database provider. It prepares candidate generations, checks readiness and selects retained good code after failure. Product routes, UI, application event browsing and optional workflows belong to the editable app.

Keep these boundaries intact when changing boot:

- Editable code runs in child processes; boot never imports it or the server implementation.
- SQLite recovery needs positive process-closure evidence. Remote writer admission uses a session advisory lock and guarantees only cooperative exclusion; a timeout is not admission.
- After an accepted generation, recovery preserves the current database. Unresolved journals block conflicting changes.
- Forward verified identity to the child, never the caller's board credentials. Only `chirp_app_` cookies may cross for application authentication. Mutations using a board session require the configured origin; managed handlers own their app-session CSRF protections.

Application-managed ingress is off by default. To enable explicitly declared application routes, create `DATA_DIR/boot.config.json` containing `{"applicationManagedIngress":true}` and restart boot. This file sits outside editable source and is not changed through the settings API. Missing configuration leaves ingress off; malformed content, unknown keys, file links, special files and oversized files disable ingress with a startup warning and authenticated `/_boot/status` diagnostic. Authentication and recovery remain available. In the isolated image, use a boot-owned file (UID 1000) with mode `0600`. A root-owned file must be readable by boot (`0644` is acceptable because it contains no secrets); neither form may be writable by group or others. Local development shares one OS user and is not an isolation boundary.

A compatible child advertises ingress support only after a successful health check. Boot delegates otherwise unauthenticated requests to a dedicated child dispatcher, which requires an explicitly application-managed route and never falls back to core routes. Boot still authenticates every supplied board credential, protects its control routes and admits writes through the normal cutover gate. Application routes own their additional authentication and cookie protections; their code can intentionally permit anonymous writes. Legacy public-path projections remain durable for historical replay but no longer authorize anonymous requests.

Local development runs under one OS user. The image separates boot, app and build users; see [deploying a board](../../../docs/deploy.md) for its limits. [Storage](storage.md) describes capacity admission, protected artifacts and retention.

SQLite is the default. PostgreSQL/MySQL use existing databases and separate credentials. Read [what recovery promises on a remote engine](../../../docs/deploy.md#what-recovery-promises-on-a-remote-engine) before changing remote recovery: rehearsal is a schema check, failed unaccepted cutovers require repair, and provider restore is followed by identity verification. There is no remote root guardian, native dump keeper or database provisioner. Boot's tables use the shared portable migration path.

## Source map

Start with [index.ts](../src/index.ts) for wiring, [supervisor.ts](../src/supervisor.ts) for child lifetime and [application.ts](../src/application.ts) for seed and snapshot selection. Recovery changes need failure, restart and durability tests in [test/](../test/), alongside `bun run check`.
