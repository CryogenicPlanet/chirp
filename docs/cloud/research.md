# Chirp Cloud research notes

> This file is not authoritative and does not need line-by-line product review. It records
> evidence, rejected options, risks, and implementation ideas. It adds no product or
> implementation requirements, including through its headings or checklists. Product intent
> lives in [`product-intent.md`](product-intent.md); settled choices live in
> [`decisions.md`](decisions.md). When either is silent or conflicts with this file, this file
> has no authority.

Research checked 2026-09-19 against Chirp commit `fde8ea4`, Alchemy commit `fdec4ccf`,
and Distilled commit `5410084`.

## Chirp constraints found in the repository

### A board is already the isolation unit

`SPEC.md` and `packages/server/src/start.ts` describe one board-scoped boot graph with one
data directory and one authoritative app writer. Boot owns credentials, sequence allocation,
recovery journals, source generations, process supervision, and database recovery. Sharing
that process between customers would move the most sensitive boundary into one multi-tenant
process and require a different product.

Boot can run temporary rehearsal, candidate, preparation, and retiring children during a
safe edit. Those are parts of one deployment, not provider replicas.

### The volume is required for every storage engine

With SQLite, `/data` contains both databases plus installed source, pages, generations,
dependency/build artifacts, closure receipts, configuration, backups, and recovery records.
PostgreSQL or MySQL moves the SQL stores only; the rest still requires the volume.

Replacing a Machine while retaining `/data` matches the existing deployment contract.

### The image needs a real Linux container boundary

The image starts as root to prepare fixed paths and launch fixed keepers, then uses UIDs
1000, 1001, and 1002. The documented container profile drops all capabilities and restores
only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`, and `SETPCAP`.
Container-wide `no-new-privileges` breaks the intended transition. SQLite crash recovery also
reads `/proc/sys/kernel/random/boot_id` as evidence that a former owner cannot still exist.

These behaviors require a live Fly compatibility test; API shape alone cannot prove them.

### Host, Origin, and RP ID are different boundaries

Chirp validates an exact browser Origin and binds passkeys to an RP ID. It does not use Host
as a tenant selector. A cloud router therefore has to validate and canonicalize Host, map it
to exactly one deployment, preserve Origin, and fail closed on ambiguity.

Changing registrable domains is a board-owned passkey migration, not an infrastructure
redirect. Generated board slugs should never be reassigned after deletion.

### Image updates do not replace editable source

The first start copies editable source to `/data`; later images retain that source. A fleet
image rollout updates the immutable launcher but is not an application feature rollout.
Cloud cannot honestly report the installed editable generation without a new scoped
attestation from Chirp.

### Current health signals are narrow

`/health` is a fixed liveness response. A successful `/init` proves that a real child route
answered at that moment. Neither is a continuing health guarantee.

## Candidate Fly shape

The investigated shape was:

- one Fly app and named custom 6PN network per board;
- one encrypted volume in one region;
- one Machine using a digest-pinned Chirp image;
- no public IP on tenant apps;
- one public router with wildcard DNS/TLS;
- `fly-replay` from the router to the selected app;
- `autostop: "stop"`, `autostart: true`, and zero minimum Machines;
- cloud-level backups, logs, metrics, and alerts.

A full stop is preferable to suspend because SQLite reopens through normal recovery and
remote SQL gets new physical sessions. Long-lived requests keep the Machine awake. Board
cron jobs and detached work do not run while stopped, so backup and monitoring schedules
must live outside editable board code.

Fly volumes are host-local. Host failure recovery means creating a new volume from a
snapshot, not attaching the old volume elsewhere. Restores must withdraw routing, prove the
old Machine is gone, advance a cloud fencing generation, and start only one replacement.

The router is a fleet-wide security boundary. A wrong target leaks public routes and can
misroute credential-bearing requests even when browser Origin checks work. Candidate defense
in depth includes a per-board replay state checked by immutable boot before any board route.
This requires a Chirp compatibility change and must not be assumed to exist today.

## Storage research

### Managed SQLite

SQLite follows Chirp's reference path and supports disposable rehearsal plus pre-cutover
rollback. It sleeps with the Machine and has no separate database compute floor. The cloud
service would own volume snapshots, encrypted off-provider archives, restore drills, and
one-way volume growth.

### External PostgreSQL

The current contract requires PostgreSQL 17+, fresh boot and app databases on one host and
port, separate roles, direct TLS connections, and no transaction-mode pooler. Chirp pins a
physical session and uses session advisory locks. The app role must have no access to boot.

External PostgreSQL has weaker cutover recovery than SQLite. A candidate migrates live data
after the former generation retires; failure after that point requires operator repair. The
provider owns database backup, PITR, availability, and stuck-session cleanup.

Provider names are not compatibility evidence. Each exact endpoint has to pass the two-role,
direct-session, lock, TLS, schema, disconnect, and identity checks.

### External MySQL

The documented target is Oracle MySQL 8.4 behavior with InnoDB and session isolation exactly
`REPEATABLE-READ`. Chirp needs two fresh databases and two users on one host and port:

- boot has all privileges on boot and documented DDL/DML privileges on app;
- app has its documented privileges on app and no access to boot;
- neither runtime user has global, account, file, process, grant, or administrative power.

The checked-in operator SQL uses escaped underscores in schema grants and requires
`partial_revokes=OFF`. URL query strings and fragments are rejected. Credentials and names
must be percent-encoded. TLS uses the image trust store and verifies the hostname, so a
private CA needs a deliberately rebuilt trust store.

A useful compatibility matrix runs the actual Chirp image, not a bag of generic SQL probes.
It needs to exercise generated columns and JSON functions, `FULLTEXT` indexes, checks,
foreign keys, exact collation and `information_schema` normalization, migration ledgers,
restart, edit/cutover, and recovery.

Lock testing has to match the implementation. One pinned connection holds the lifetime
writer `GET_LOCK`, acquires and releases a second migration lock, and keeps the first lock
throughout. A competitor stays refused. Killing the admitted connection makes that client
fail closed, and a fresh client can later acquire.

Restricted users intentionally cannot inspect or kill arbitrary sessions. A provider can
retain a half-open session and lock after host failure, so onboarding needs an owner/operator
runbook or provider API for identifying and terminating the exact holder.

The research recommendation was to leave PlanetScale's Vitess-backed MySQL product outside
the first release unless it passes a dedicated compatibility proof. This is not a settled
named-provider decision. Vitess documents reserved-connection locking, while PlanetScale
documents unsupported triggers and provider-managed user/DDL semantics. The current stock
MySQL schema relies heavily on generated columns and full-text behavior. Only an end-to-end
image test could establish compatibility.

## Control-plane research

The investigated control plane uses Better Auth's PostgreSQL adapter, ordinary OAuth, and
optional Passkey and Admin plugins. Public signup is disabled; a signed, single-use
invitation gates initial account creation regardless of sign-in method. Cloud ownership
authorizes infrastructure actions only; it does not create a Chirp board session.

Candidate metadata includes accounts, invites, deployments, operations, and immutable audit
events. Provider resource IDs are references, not truth; reconciliation reads provider
state before mutation. Friendly names remain private metadata, while board hostnames use a
random 128-bit slug and are permanently tombstoned after deletion.

Provisioning needs an asynchronous, durable state machine. The researched order is:

```text
requested
  -> storage_configuration_verified
  -> app_created
  -> volume_created
  -> runtime_secrets_written
  -> machine_created
  -> machine_started
  -> edge_reachable
  -> child_route_observed
  -> provisioned
```

Every provider mutation for one deployment shares a durable lease. Ambiguous create results
are observed before retry, because a timeout is not proof that nothing happened. Machine
updates use the observed version guard. Once a volume exists, an unrelated later timeout
must not trigger automatic data deletion.

Deletion was researched as two phases: immediately remove routing and stop the Machine,
then retain managed recovery material for a stated grace period before destruction. The
retention period is not decided.

The current OSS setup flow prints a one-time code to logs. A managed product probably needs
a provider-neutral one-time setup handoff, but its exact implementation is not settled and
must preserve human-approved first enrollment.

## Alchemy review

Alchemy `2.0.0-beta.79` at commit `fdec4ccf` has substantive Fly providers rather than a
thin example. Full providers exist for Apps, Machines, App secrets, IP assignments, and
certificates. Machine services map Fly's autostart, autostop, zero-minimum, ports, and health
checks. Apps and IP assignments accept a named custom network.

The boundary is incomplete for tenant data:

- there is no standalone Volume or Network provider;
- mounted volumes are internal to Machine/Service reconciliation;
- destroying or reducing a Machine replica set deletes its attached volumes;
- a snapshot delete is a no-op because Fly has no snapshot-delete API;
- Machine update does not pass the available version guard and catches conflict without
  replanning;
- normal reconciliation starts a stopped Machine unless `skipLaunch` is set;
- `Redacted` inputs are unwrapped into recoverable JSON in persisted state;
- list ownership uses heuristics and is unsafe as authoritative mixed-resource inventory.

Alchemy's PostgreSQL state backend uses a nonblocking advisory lock per stack/stage and
checks the holder from another connection. It needs at least two pooled connections and
caches a successful liveness check for five seconds. The lock covers only deploys using the
same state database, prefix, stack, and stage; it does not serialize direct runtime Fly
operations.

Programmatic deployment with a caller-selected stage is real, but it does not supply a
workflow scheduler or solve the lifecycle issues above. The researched recommendation was
therefore to use pinned Alchemy only for reviewed, shared, stateless infrastructure and the
pinned `@distilled.cloud/fly-io` Effect client for tenant operations.

The Distilled client exposes Fly's update version guard but defaults to retrying transient
errors up to eight times. Reads can use that policy. Non-idempotent mutations need retries
disabled unless the operation has proved idempotency; after an ambiguous result the workflow
observes provider state before acting again.

## Alternatives considered

- **Railway:** closest fallback to Chirp's documented container-plus-volume deployment, but
  volume-backed services stay provisioned and the per-board object/cost model is heavier.
- **One managed VM with Docker and Caddy:** cheaper at small scale while keeping one
  container per board, but makes Chirp Cloud responsible for host security, placement,
  noisy neighbors, disk failure, backup, and failover.
- **Shared PostgreSQL cluster:** cheaper but weakens per-board isolation, recovery, and
  noisy-neighbor boundaries.
- **PostgreSQL sidecar per Machine:** makes Chirp Cloud a database operator while retaining
  local-volume fragility and remote-engine cutover limits.
- **Cloud Run and similar stateless runtimes:** poor fit for the required POSIX volume and
  container privilege model.
- **Kubernetes/ECS:** can implement the design but adds cluster and volume-placement work
  before the product needs it.

## Proposed validation if this researched design is selected

1. Run the Chirp image on Fly with its exact capabilities, UID transitions, keepers,
   `/proc` access, volume, cold start, graceful idle stop, edit/reload, and recovery.
2. If wildcard `fly-replay` and replay-state validation are selected, test streams, large
   bodies, exact Host/Origin, wake from stop, and wrong/missing replay-state refusal.
3. Run snapshot, archive, restore, and single-writer fencing under active writes.
4. Run the real PostgreSQL and MySQL image matrices on candidate provider endpoints.
5. If Alchemy is selected, test deploy, drift read, interrupted apply, concurrent deploy
   rejection, certificate observation, and destroy in a disposable Fly organization.

Until those pass, these are researched implementation candidates rather than implemented
Chirp Cloud behavior.

## Primary sources

Repository:

- `SPEC.md`
- `Dockerfile`
- `docs/deploy.md`
- `packages/boot/docs/storage.md`
- `packages/boot/sql/mysql-roles.sql`
- `packages/storage/src/store.ts`
- `packages/storage/src/remote-driver.ts`
- `packages/storage/src/remote-client.ts`
- `packages/storage/src/remote-migrations.ts`
- `packages/storage/src/schema-shape.ts`
- `packages/server/src/ext/core/core-schema-remote.ts`

External:

- [Fly Machines API](https://fly.io/docs/machines/api/)
- [Fly per-user environments](https://fly.io/docs/blueprints/per-user-dev-environments/)
- [Fly custom private networks](https://fly.io/docs/networking/custom-private-networks/)
- [Fly dynamic request routing](https://fly.io/docs/networking/dynamic-request-routing/)
- [Fly autostop/autostart](https://fly.io/docs/reference/fly-proxy-autostop-autostart/)
- [Fly volume snapshots](https://fly.io/docs/volumes/snapshots/)
- [Alchemy commit `fdec4ccf`](https://github.com/alchemy-run/alchemy/commit/fdec4ccf8230e2a31fcd115d7936b8c42be2306b)
- [Distilled commit `5410084`](https://github.com/alchemy-run/distilled/commit/541008479d7b5c1b713e8087b229ac2e3785456e)
- [MySQL 8.4 locking functions](https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html)
- [PlanetScale MySQL compatibility](https://planetscale.com/docs/vitess/troubleshooting/mysql-compatibility)
- [Vitess locking functions](https://vitess.io/docs/25.0/reference/query-serving/locking-functions/)
- [Better Auth passkeys](https://better-auth.com/docs/plugins/passkey)
