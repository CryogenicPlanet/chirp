# `@comms/cloud`

Chirp Cloud is the full-stack Next.js dashboard and control plane. It always ships the browser application and backend together; there is no supported headless mode. Shared Effect schemas provide the typed browser/server contract, while server-only Effect services own durable work and provider access.

Cloud does not import board server or boot internals. A deployed board is an opaque, versioned Chirp image operated through public behavior, and cloud authentication never substitutes for a board session.

The current foundation uses PostgreSQL for control-plane state. It owns private board metadata and a leased, fenced operation queue; provider resources, authentication, HTTP, and UI arrive in later stack layers.
