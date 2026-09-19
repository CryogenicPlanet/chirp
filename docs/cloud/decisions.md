# Chirp Cloud decisions

This is the small authoritative record of choices made in the cloud design discussion. If
[`research.md`](research.md) disagrees with this file, this file wins.

## Settled

- The dashboard is `cloud.chirp.wiki` and uses invitation-only Better Auth with GitHub,
  Google, and passkey sign-in.
- Boards receive opaque generated `*.boards.chirp.wiki` addresses. Friendly board names stay
  private to the dashboard.
- Cloud authentication controls infrastructure. Chirp passkeys and agent tokens control the
  board. They remain separate.
- Fly Machines is the first hosting backend.
- The managed default is demand-started SQLite with persistent board storage.
- Compatible external PostgreSQL and MySQL are advanced bring-your-own options selected when
  the board is deployed. The existing [deployment contract](../deploy.md#postgresql-and-mysql)
  remains authoritative for their database setup and recovery limits.
- Changing a board's storage engine is not a migration feature.
- The first release does not delete boards or their storage.
- Alchemy manages shared stateless infrastructure only. The cloud control plane creates and
  reconciles boards directly through Fly's API; boards are runtime product resources, not
  infrastructure-as-code stacks.
- Managed SQLite boards are backed up every 24 hours. The dashboard reports the last
  successful backup rather than promising success from the schedule alone.
- The control plane stays in this public repository under `packages/cloud`.

## Still open

- Backup retention and the recovery-point promise beyond the 24-hour cadence.
