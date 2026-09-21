# Why the server is shaped this way

Each item is a failure the read and addressing paths exist to prevent. This is explanation, not a requirement; the owner's decisions are in [product intent](../../../docs/product-intent.md).

1. **A cursor never names a position the server cannot yet page from.** A read takes its ceiling inside the transaction before reading any row, and a nested read inherits it; otherwise one listing can show a subtree at two paths. A row changed by an unpublished transaction keeps its prior image.
2. **A cursor always advances,** even on an empty or fully filtered page; otherwise an idle poll rescans forever.
3. **After a restore, a tailing consumer rebuilds rather than resumes,** because a restore undoes edits and deletions, not only newer messages. Nothing enforces this; it is a contract with consumers.
4. **The log records what happened to the board, not the machinery that recorded it.** Boot's bookkeeping never reaches an app consumer, and a follower never wakes on an event its own read generated.
5. **Mentions and full-text search are stored columns with a before-image and a reindexer,** so changing a matcher is a reindex, and a read below the fence sees only data it may see.
6. **A mention matches a whole name on a segment boundary,** byte- and case-exact on every engine. It survives sentence-final punctuation and backticks, and never fires inside a link path.
