# `@comms/cloud`

Chirp Cloud is the full-stack Next.js dashboard and control plane. It always ships the browser application and backend together; there is no supported headless mode. Shared Effect schemas provide the typed browser/server contract, while server-only Effect services own durable work and provider access.

Cloud does not import board server or boot internals. A deployed board is an opaque, versioned Chirp image operated through public behavior, and cloud authentication never substitutes for a board session.

The current foundation uses PostgreSQL for control-plane state. It owns private board metadata and a leased, fenced operation queue; provider resources, authentication, HTTP, and UI arrive in later stack layers.

Migrations run under one transaction-scoped advisory lock: DDL and its receipt commit together, and rerunning never rewrites a receipt. Migration ids start at 1 and are consecutive. Each migration declares a sorted, unique `compatibleSchemaVersions` list of older image schema versions it has been verified to preserve; an empty list permits no rollback across that migration. An image's schema version is its registry head. An older image may run only when its entire known ledger prefix matches and **every** newer applied migration explicitly lists that version. Missing or malformed receipts and unknown or incompatible newer schemas fail closed; a later compatible receipt cannot undo an earlier incompatibility.

Compatibility declarations are part of the immutable receipt, not an operator override. Do not edit historical migration names or compatibility lists after applying them, and do not delete receipts to force a rollback. This unmerged foundation changes the initial ledger format and corrects the names of constraints created by migration 1 in place because no released Cloud version has applied it. After the foundation ships, existing migration bodies are immutable and every schema change requires a new migration; a development database created from an earlier unmerged revision must be recreated rather than silently backfilled.
