# Why boot is shaped this way

Each item is a failure boot exists to prevent. This is explanation, not a requirement; the owner's decisions are in [product intent](../../../docs/product-intent.md). A **Gap** marks where the code does not yet meet the intent.

## Writes and cutover

1. **No acknowledged write is lost.** Once the board answers with a `seq`, the write survives a cutover, a rollback, a restart and a crash. Evidence of a write commits in the same transaction as the write, and a control deadline is not a drain. A deliberate delete through the API is an honored write.
2. **A generation that has not proved itself never serves.** It starts against a copy of the data and must pass a readiness check and a synthetic write and read. Remote engines cannot copy the data first; see [deploy.md](../../../docs/deploy.md#what-recovery-promises-on-a-remote-engine). **Gap:** the proof does not exercise product routes, so a missing or overridden route is not caught.
3. **A human can always get back in.** The edit, revert and recovery routes answer whatever the app has done. This outranks the two above.
4. **A timeout is not evidence that a write rolled back.** Abort a publication only on confirmed absence. Before replacing an app store, hold positive evidence that every previous owner is gone; a process id, a refused connection, a timeout, a permission error or a spawn error is not that evidence. When evidence is missing or inconsistent, block and report.
5. **Only one generation writes the app store.** A writer that lost that right is refused inside its own transaction. A missing app store is reported, never recreated empty.
6. **Nothing half-staged deploys.** Staging lives outside the tree the app runs from, preparation runs in a disposable workspace, and an interrupted edit is dropped and reported.
7. **Source recovery is automatic; database recovery waits for a person** and a fresh passkey assertion, because restoring data destroys other agents' work.
8. **An expired edit lock is reclaimed only when no cutover is running under it.**
9. **Replay compares only against records still present,** so pruning is never undone by replay.

## The floor

The threat model is mistakes, not an adversary holding a valid token. A rehearsal runs as the same user as the live app, so it proves a generation works, not that it is contained.

10. **Boot imports nothing from the editable tree, and the app cannot shadow boot's paths.** No failure of this one can be recovered from inside the product.
11. **Boot names three app tables:** `kernel_writer`, `mutation_batches` and `outbox`. A fourth is a decision about the boundary. **Gap:** `scripts/check-invariants.ts` sees only literal `CREATE TABLE` statements, and boot also creates `store_identity` in the app store.
12. **Application-managed ingress needs explicit operator delegation.** A missing policy, failed extension or incompatible generation never falls through to a private handler.
13. **The app never sees a board credential and cannot forge an identity.** Boot strips board authorization, session cookies and caller identity headers, and injects only verified identity.
14. **Boot, the app and the dependency build run as three OS users.** The app cannot open boot's database or write the generation tree, and the build user can read neither database. The app and build users run with no new privileges; boot cannot, because it uses sudo.
15. **A token counts as used the moment it authenticates,** not when its request succeeds, so a stolen token that then fails still leaves evidence.
16. **Root is reached only through the image entrypoint and two sudo keepers.** **Gap:** the child keeper does more than spawn and set ownership: it writes receipts, copies the rehearsal database, deletes recursively, and stays resident as root.
17. **Root helpers take no arguments;** input arrives in one environment variable. **Gap:** `ChildConfiguration.env` (`keeper-configuration.ts`) is an open record passed to `setpriv`, so that variable controls root's environment, including `LD_PRELOAD`.
18. **No privileged path operation should follow a link.** **Gap:** `ownTree` and `sharePages` (`linux-ownership.ts`) recurse and use a path-based `chown` after a `realPath` check, a race the app's group can reach through `/data/pages`.
19. **Boot never runs a command the editable tree can name.** Dependency installation runs with lifecycle scripts disabled under a reset environment, and editable build code runs only as the build user in a disposable tree.
20. **The internal channel checks its per-attempt secret in constant time** and refuses a mismatched host or an `x-forwarded-*` or `forwarded` header. **Gap:** it never checks the remote address, so a layer-4 proxy or published port would pass a leaked secret.

## Remote engines

These pass on SQLite and fail only on PostgreSQL or MySQL.

21. **A transaction that reads a singleton and writes a value derived from it locks that row.** Otherwise sequence allocations interleave. The lock is a no-op on SQLite, so reading the code will not reveal why it is there.
22. **Boot and the app use two databases and two roles,** and both settings must agree on engine, host and port or startup refuses. Boot reads the app's database through role membership and holds the app's URL only to redact it. On a remote engine the provider backs up and restores the app database, not boot.
