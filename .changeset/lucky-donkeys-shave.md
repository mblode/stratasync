---
"@stratasync/client": minor
"@stratasync/react": minor
---

Land the boot state in one step instead of animating through it.

A warm start emitted one reaction flush per row (5,000 rows meant 5,000 flushes),
and a multi-page catch-up emitted one flush per page while writing roughly two
IndexedDB transactions per action. Hydration is now batched, a delta packet
resolves in memory and persists as a single `writeBatch`, and a paged backlog is
merged into one packet. Measured in Chrome against real IndexedDB, catch-up over
4,000 actions went from 928 ms to ~230 ms, and warm-start flushes from 5,000 to 1.

`useQuery` now tracks which ids satisfy its predicate and skips the rescan when a
change can't affect the result, instead of re-scanning and re-sorting the whole
model on every change.

New: `client.catchingUp`, the `catchUpChange` event, `isCatchingUp` on the React
sync status, and `useSyncCatchingUp()`. Readiness is deliberately not gated on it —
the client stays ready and renders cached data throughout, so it is for a quiet
indicator.

Fixes:

- `instant` and `local` models are no longer LRU-evicted. `ensureModel` refuses to
  refetch them, so eviction silently shrank every query against a model past
  `identityMapMaxSize` (default 10,000) until the next bootstrap, and destroyed the
  only copy of `local` data.
- Outbox transactions now carry a strictly increasing `batchIndex`. The field was
  already indexed and used as a replay-order tie-break, but never assigned, so
  transactions created in the same millisecond replayed in random `clientTxId`
  order — a create and its dependent update could invert after a reload.
- A `"C"` (covering) sync action now fetches the rows behind the newly covered
  partial-index key before recording coverage. Recording it first left
  `loadByIndex` reporting a complete-but-empty set with no path to repair.
