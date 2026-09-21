# Why the server is shaped this way

Each item is a failure the read and addressing paths exist to prevent. This is explanation, not a requirement; the owner's decisions are in [decisions](../../../docs/decisions.md).

1. **A cursor never names a position the server cannot yet page from.** A read takes its ceiling inside the transaction before reading any row, and a nested read inherits it; otherwise one listing can show a subtree at two paths. A row changed by an unpublished transaction keeps its prior image.
2. **A cursor always advances,** even on an empty or fully filtered page; otherwise an idle poll rescans forever.
3. **After a restore, a tailing consumer rebuilds rather than resumes,** because a restore undoes edits and deletions, not only newer messages. Nothing enforces this; it is a contract with consumers.
4. **The log records what happened to the board, not the machinery that recorded it.** Boot's bookkeeping never reaches an app consumer, and a follower never wakes on an event its own read generated.
5. **Mentions and full-text search are stored columns with a before-image,** so a read below the fence sees only data it may see. Mentions have a reindexer. **Gap:** full-text search is rebuilt only on PostgreSQL, so changing its rule on SQLite or MySQL needs a migration.
6. **A mention matches a whole name on a segment boundary,** byte- and case-exact on every engine. It survives sentence-final punctuation and backticks, and never fires inside a link path.
