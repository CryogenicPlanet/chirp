# Operating Chirp Cloud

This guide is for people hosting Cloud. For creating and using a board, start with the [Cloud guide](README.md).

Cloud needs a PostgreSQL database for accounts and deployment records, at least one OAuth provider, and Fly and Cloudflare credentials for managed boards. The dashboard and backend deploy together. Cloud sessions do not authenticate into board content.

## Configure authentication

Copy [.env.example](.env.example) to `.env.local` in this package and replace the placeholders. Set `CLOUD_DATABASE_URL` and generate `BETTER_AUTH_SECRET` from at least 32 random bytes. Set `BETTER_AUTH_URL` to the exact browser origin.

Configure either complete OAuth pair (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, or `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`), or both. Leave unused pairs blank; partial pairs are rejected. Register these callbacks with the corresponding provider:

- `BETTER_AUTH_URL/api/auth/callback/github`
- `BETTER_AUTH_URL/api/auth/callback/google`

Set `CLOUD_CLIENT_IP_HEADER` to one authoritative, single-value client-IP header written by your trusted edge proxy. On Fly, use `fly-client-ip`. The proxy must replace caller-supplied values, and clients must not be able to bypass it. Missing, malformed, or multi-value headers cause authentication to fail. The production listener binds IPv4 and rejects direct IPv6 Fly 6PN traffic.

For local browser testing, put a trusted local proxy in front of Next.js that supplies this header, and use that proxy's origin for `BETTER_AUTH_URL` and OAuth callbacks. `next dev` does not add the header. Restart the development server after changing authentication configuration.

Run commands below from the repository root after `bun install --frozen-lockfile`:

```sh
bun run --filter @comms/cloud migrate
bun run --filter @comms/cloud invite
bun run --filter @comms/cloud dev
```

The invitation command prints a relative `/invite#…` link once. Prepend `BETTER_AUTH_URL` and open it to create the first account. Links accept any verified OAuth account, work once, and expire after 24 hours. Keep the full link private.

Set `CLOUD_OPERATOR_EMAILS` to a comma-separated list of verified account emails allowed to issue invitations from the dashboard. Empty configuration denies dashboard issuance. Each operator can create up to 20 links per hour; the database-access CLI is outside that quota. Existing email-bound invitations retain their restriction.

## Run the complete server

The development command runs the UI and request handlers without the provisioning workers. For provisioning and deletion, configure the provider settings below, then build and start the custom server:

```sh
bun run --filter @comms/cloud build
bun run --filter @comms/cloud start
```

Startup checks and applies migrations before serving. The server runs provisioning and deletion workers alongside Next.js; keep it running between dashboard requests. Cloud's database is separate from every board's database. Back it up along with the private configuration needed to recover it.

## Deploy to Fly

Edit [fly.toml](fly.toml) for your Cloud app, region, `FLY_ORGANIZATION`, and `BOARDS_DOMAIN`. Keep one Cloud machine running with automatic stopping disabled so background work can progress. The release command applies migrations before the new image serves.

Publish the board image first, from the repository root:

```sh
flyctl deploy --config fly.board-image.toml --build-only --push --image-label board-<commit>
```

Set `CHIRP_IMAGE` to the resulting **digest-pinned** image reference. Board images must include the immutable setup-code command at `/opt/comms/packages/boot/dist/setup-code.js` for dashboard setup codes to work. A board keeps the image it was created with: changing `CHIRP_IMAGE` affects only new boards, and Cloud cannot move an existing board to a newer image. Codes expire after 15 minutes, replace previous setup challenges, and cannot be issued after the first board passkey exists.

Import secrets with `flyctl secrets import --config packages/cloud/fly.toml`: `CLOUD_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, the configured OAuth pairs, `CLOUD_OPERATOR_EMAILS`, `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and `CHIRP_IMAGE`. Add `CLOUD_SECRETS_KEY` if offering PostgreSQL boards. Keep provider tokens only in Cloud's environment, never in board environments or the database. Use an organization-scoped Fly token with access to app creation, Machines, Volumes, shared public IPs, and certificates.

Build with the repository root as context and this package's ignore file; the root ignore file excludes assets Cloud needs:

```sh
flyctl deploy --config packages/cloud/fly.toml --dockerfile packages/cloud/Dockerfile \
  --ignorefile packages/cloud/dockerignore --ha=false
```

The Cloud hostname needs DNS-only `A`/`AAAA` records at the addresses reported by `flyctl ips list --config packages/cloud/fly.toml`, plus a Fly certificate. Do not proxy those records: this interferes with certificate validation and accurate client-IP reporting.

## Board networking

Cloudflare must be authoritative for the active zone containing `BOARDS_DOMAIN` (default `boards.chirp.wiki`). Do not delegate the boards subdomain elsewhere. Set `CLOUDFLARE_ZONE_ID` to the zone's 32-character ID and scope the token to that zone with **Zone / DNS / Edit** and **Zone / Zone / Read** permissions.

Each board gets its own shared public IPv4 assignment, certificate, DNS-only `A` record, and Fly ownership `TXT` record. No wildcard setup is required. Matching records can be adopted; conflicting, proxied, duplicate, or delegated records require operator repair and are never overwritten. Certificate validation requires the expected A address without an AAAA override. DNS propagation and certificate issuance can take time; a healthy provider resource alone does not establish that the board is reachable.

Reconciliation runs for new and resumed provisioning operations, not as a continuous repair sweep of completed boards. Plan large rollouts around certificate issuance limits.

## PostgreSQL boards

Set `CLOUD_SECRETS_KEY` to an independent 32-byte key encoded as 64 hexadecimal characters (`openssl rand -hex 32`). Back it up privately with the control-plane database. Losing or changing it prevents decrypting queued and retryable board credentials.

Use a direct PostgreSQL administrator endpoint with database and role creation privileges, not a transaction pooler. Cloud creates board-specific databases and restricted logins and refuses unrelated existing objects. The administrator URL is encrypted until bootstrap is confirmed, then replaced by encrypted board-scoped credentials. Only the derived credentials are staged in Fly Secrets.

Public endpoints must resolve to public IPv4 addresses and use verified TLS. `sslmode=require` and `sslmode=verify-full` are accepted. `channel_binding=require` is rejected because the drivers cannot enforce it; remove that parameter while retaining verified TLS. Other query overrides, private/reserved addresses, and IPv6 are refused. `CLOUD_POSTGRES_ALLOW_LOCAL=true` permits loopback, including `sslmode=disable`, for isolated local tests only; never enable it on hosted Cloud.

PostgreSQL boards still need a managed volume for source and local data. Database backups and restores are the database operator's responsibility. Cloud does not delete external databases. MySQL creation is not offered by the dashboard.

## Upgrades and rollback

Back up the control-plane database before upgrading. Stop old workers before applying migrations that change worker behavior, then deploy the matching Cloud version. In particular, old workers do not understand migration 7's deletion state, migration 9's PostgreSQL secret checkpoint, or migration 10's readable slugs and volume names. Provisioning-recovery migrations can conservatively mark uncertain earlier provider writes for inspection.

Migration receipts are immutable. An older image can run only when its known ledger matches and every newer migration explicitly declares compatibility with that image's schema version. Migration 9 is not rollback-compatible. Do not edit receipts or historical migrations to force startup. Recreate disposable development databases made from incompatible unmerged revisions rather than rewriting their history. Migration 11 permits generic invitations without changing existing email-bound links.

## Recover blocked provisioning

The board page shows the last confirmed progress, diagnostic code, and whether work has stopped. Healthy readiness checks and uncertain provider writes can remain pending; definite rejection, changed resource identity, or exhausted limits block provisioning. Defaults are ten transient failures, a 24-hour operation lifetime, and 30-second polling, controlled by `PROVISIONING_MAX_FAILURES`, `PROVISIONING_MAX_AGE_MS`, and `PROVISIONING_POLL_INTERVAL_MS`.

Resolve the reported provider or configuration issue first. Inspect the failed operation ID, checkpoint, error, and current deployment `row_version` using operator access to `CLOUD_DATABASE_URL`, then run:

```sh
FAILED_OPERATION_ID=<failed-operation-uuid> EXPECTED_DEPLOYMENT_ROW_VERSION=<row-version> \
  bun run --filter @comms/cloud retry:deployment
```

This queues one retry from the saved checkpoint with a fresh budget. Repeating it for the same failed operation returns the existing retry. Stale versions, active operations, and superseded failures are refused. Resources are re-observed; missing or changed identities block again. Restore the original configuration or resource identity rather than editing IDs or recreating a missing volume. This command retries provisioning; it does not restore data.

If independent provider inspection proves a recorded mutation never took effect, add a comma-separated `CONFIRMED_ABSENT_MUTATIONS` value. Allowed names are `app_create`, `volume_create`, `machine_create`, `machine_start`, `edge_ip`, `edge_certificate`, `edge_a_record`, and `edge_txt_record`. Only recorded markers can be cleared. An empty eventually consistent list is not proof of absence. Machine starts can be retried automatically because they create no resource; other uncertain writes are observed rather than blindly repeated.

## Deletion and backups

Confirmed deletion removes the recorded machine and volume only after checking their identities. Active operations or unresolved provider mutations prevent deletion. A failed deletion appears as needing attention; after fixing the cause, confirm deletion again to queue a new attempt. The board counts toward quota until provider absence is confirmed.

Managed volume data is permanently removed. External databases, the verified empty Fly app, and Cloudflare records are retained. Operators may remove obsolete DNS records only after independently verifying ownership. Encrypted PostgreSQL credentials are purged when deletion completes. Tombstones preserve slug reservations.

Managed SQLite volumes have Fly automatic snapshots enabled. Cloud periodically records the newest snapshot reported as completed, including observed retention. This is provider metadata, not proof of SQLite consistency or a tested restore. There is no Cloud restore workflow or guaranteed retention beyond what the provider reports.
