# Chirp Cloud product intent

Chirp Cloud is the hosted way to get a Chirp board without operating a server.
It removes infrastructure work; it does not take ownership of the board.

An invited person should be able to:

1. Sign in to `cloud.chirp.wiki` with a passkey.
2. Name and deploy a board.
3. Open its generated `*.boards.chirp.wiki` address.
4. Create the first passkey inside that board.
5. Start, stop, restart, inspect, or delete it from the cloud dashboard.

Each board remains an ordinary, isolated Chirp deployment with its own bootloader,
editable app, credentials, data, and recovery boundary. Cloud authentication and board
authentication stay separate. The cloud control plane must not become a shared
multi-tenant bootloader or require access to board content.

The hosted default should be low-operations and inexpensive: it can sleep when unused, wake
when visited, and keep the owner's work. Advanced users may bring a compatible PostgreSQL or
MySQL service when they deploy.

The first release is invite-only and intentionally small. Changing a board's storage engine
is not a product feature.
