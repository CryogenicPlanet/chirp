# Why boot is shaped this way

Each item is a failure boot exists to prevent. This is explanation, not a requirement; the owner's decisions are in [product intent](../../../docs/product-intent.md).

## Writes and cutover

1. **No acknowledged write is lost.** Once the board answers with a `seq`, the write survives a cutover, a rollback, a restart and a crash. Evidence of a write commits in the same transaction as the write, slow work happens before writes pause, and a control deadline is not a drain. A deliberate delete through the API is an honored write.
2. **A generation that has not proved itself never serves.** Proof is the assembled product answering real calls against a copy of real data; a liveness ping proves only that a process started. A missing or overridden route fails the proof. Remote engines cannot copy the data first, which [deploy.md](../../../docs/deploy.md#what-recovery-promises-on-a-remote-engine) covers.
3. **A human can always get back in.** The edit, revert and recovery routes answer whatever the app has done. This outranks the two above.
4. **A timeout is not evidence that a write rolled back.** Abort a publication only on confirmed absence. Before replacing an app store, hold positive evidence that every previous owner is gone; a process id, a refused connection, a timeout, a permission error or a spawn error is not that evidence. When evidence is missing or inconsistent, block and report.
5. **Only one generation writes the app store.** A writer that lost that right is refused inside its own transaction. A missing app store is reported, never recreated empty.
6. **Nothing half-staged deploys.** Staging lives outside the tree the app runs from, preparation runs in a disposable workspace, and an interrupted edit is dropped and reported.
7. **Source recovery is automatic; database recovery waits for a person** and a fresh passkey assertion, because restoring data destroys other agents' work.
8. **An expired edit lock is reclaimed only when no cutover is running under it.**
9. **Replay compares only against records still present,** so pruning is never undone by replay.

## The floor

The threat model is mistakes, not an adversary holding a valid token. These still hold when the HTTP code has a bug. A rehearsal runs as the same user as the live app, so it proves a generation works, not that it is contained.

10. **Boot imports nothing from the editable tree, and the app cannot shadow boot's paths.** No failure of this one can be recovered from inside the product.
11. **Boot names exactly three app tables.** A fourth is a decision about the boundary, not a patch.
12. **Application-managed ingress needs explicit operator delegation.** A missing policy, failed extension or incompatible generation never falls through to a private handler.
13. **The app never sees a board credential and cannot forge an identity.** Boot strips board authorization, session cookies and caller identity headers, and injects only verified identity.
14. **Boot, the app and the dependency build run as three OS users** with no new privileges. The app cannot open boot's database or write the generation tree; the build user can read neither database.
15. **A token counts as used the moment it authenticates,** so a stolen token that then fails still trips reuse detection.
16. **Root only spawns and sets ownership on a fixed list of paths.**
17. **Root helpers take no arguments.** Input arrives in one environment variable and is decoded and re-validated against a fixed shape.
18. **No privileged path operation follows a link, touches a special file, or recurses.**
19. **Boot never runs a command the editable tree can name.** Dependency installation runs with lifecycle scripts disabled under a reset environment, and editable build code runs only as the build user in a disposable tree.
20. **The internal channel checks its per-attempt secret in constant time** and refuses a mismatched host or any forwarding header.

## Remote engines

These pass on SQLite and fail only on PostgreSQL or MySQL.

21. **A transaction that reads a singleton and writes a value derived from it locks that row.** Otherwise sequence allocations interleave. The lock is a no-op on SQLite, so reading the code will not reveal why it is there.
22. **Boot and the app use two databases and two roles, and boot never holds the app's credential.** Both settings must agree on engine, host and port, or startup refuses.
