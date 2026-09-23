---
"@stratasync/core": patch
"@stratasync/client": patch
"@stratasync/server": patch
"@stratasync/transport-graphql": patch
---

Fix sync races and ordering bugs found by formally modelling the engine in Lean: outbox delivery order and double sends after reconnect, stale runs mutating a restarted client, a late socket close event tearing down its replacement, rollback to stale originals, undo of archive state, own-echo divergence and spurious conflicts, and server publishing out of commit order.
