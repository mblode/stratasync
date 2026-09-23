---
"@stratasync/core": patch
"@stratasync/client": patch
"@stratasync/server": patch
"@stratasync/transport-graphql": patch
"@stratasync/storage-idb": patch
---

Fix sync races and ordering bugs found by formally modelling the engine in Lean: outbox delivery order and double sends after reconnect, stale runs mutating a restarted client, a late socket close event tearing down its replacement, rollback to stale originals, undo of archive state, own-echo divergence and spurious conflicts, and server publishing out of commit order.

A second round fixes: live cursor/identity-map lag after a failed packet, stale continuations across runs, stub rows from updates/archives of unloaded rows, stale rollback originals under IndexedDB, ghost rows on rollback, outbox replay order under clock skew, in-flight transactions reported as rejected, state-lock overlap across reset, stranded WebSocket subscriptions after a failed connect, cross-process publish order on the server, stale cursors after retention empties sync_actions, and composite keyset pagination with NULL fields.
