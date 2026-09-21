# Chirp Cloud decisions

This records the choices carried forward from the Cloud design discussion, separately from
[product intent](product-intent.md) and [research](research.md). These are design choices,
not claims about shipped behavior. Research does not settle an unrecorded question.

The choices below are restored from commit `f18015a9` in [PR #30](https://github.com/CryogenicPlanet/chirp/pull/30).
That is their document provenance; the earlier record does not include per-choice owner
quotations. Preserve that distinction rather than inventing evidence or deleting the choices.
Future changes should record their date, reason, source discussion, and what they supersede.

## Recorded choices

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
- The intended managed SQLite backup cadence is every 24 hours. The dashboard reports the last
  successful backup rather than promising success from the schedule alone.
- The control plane stays in this public repository under `packages/cloud`.

## Still open

- Backup retention and the recovery-point promise beyond the 24-hour cadence.
