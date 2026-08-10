---
"@stratasync/core": minor
"@stratasync/client": minor
"@stratasync/server": minor
"@stratasync/react": minor
"@stratasync/mobx": minor
"@stratasync/next": minor
"@stratasync/y-doc": minor
"@stratasync/storage-idb": minor
"@stratasync/storage-local": minor
"@stratasync/transport-graphql": minor
---

Land sync updates as whole states instead of streaming them through the UI (wire protocol unchanged).

- **Delta packets persist in one write.** A packet now resolves against an in-memory staging area and flushes as a single `writeBatch`. Previously each action did its own `get` then `put`, and against real IndexedDB each opens a separate transaction — so a 1000-action catch-up page meant ~2000 serialized round trips.
- **Multi-page catch-up applies as one packet.** Pages are buffered and merged so a client returning from a long disconnect lands on final state in one update rather than animating through the backlog. The buffer is capped (10,000 actions) so a badly stale client stays memory-bounded.
- **Warm start hydrates in one batch.** `hydrateIdentityMaps` reads every eager model, then commits inside a single `batch()`. Committing row-by-row emitted one reaction flush per row, which is what made a warm start visibly churn through the dataset.
- **`useQuery` skips irrelevant changes.** The hook tracks which ids currently satisfy its predicate; a change touching neither the matched set nor a newly matching row returns without rescanning and re-sorting the whole model.
- **New:** `useSyncCatchingUp()` (React), `SyncClient.catchingUp`, and a `catchUpChange` event. The client stays `"syncing"` and renders cached data throughout, so this is for a quiet indicator — not for gating readiness.
- **Fix:** a `"C"` (covering) action for a `partial` model now batch-loads the rows behind the newly covered key before recording coverage. Recording it first left `loadByIndex` reporting a complete — but empty — set, with nothing to trigger a repair.
- **Fix:** queued transactions carry a monotonic `batchIndex`. `createdAt` is millisecond-resolution, so same-tick transactions tied and the outbox replay order fell through to comparing random `clientTxId`s — meaning `create X` then `update X` in one tick could replay out of order after a reload.
- **Fix:** identity map LRU eviction is now limited to demand-loadable models. Evicting an `instant` model silently shrank every query against it until the next bootstrap (`ensureModel` refuses to refetch those), and `local` models have no other copy.
