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

Client decomposition follow-up (wire protocol unchanged).

- The sync orchestrator is split into focused modules (`sync/delta-pipeline`, `sync/bootstrap-runner`, `sync/sync-groups`, plus shared pending-hydration/context); the orchestrator file drops from ~1630 to ~520 LOC and is now lifecycle + wiring. All replay-barrier, deferred-rollback, echo-suppression, cursor-monotonic, and group-change invariants are preserved (the 43-test sync-engine suite is unchanged).
- `client.ts` is decomposed into a `MutationCoordinator` (table-driven mutations, no more self-reference hack), `LazyLoader`, and `materializer`; the facade drops from ~1300 to ~810 LOC.
- **Breaking:** the client no longer imports `@stratasync/y-doc` at runtime. `SyncClientOptions.yjsTransport` is removed; pass `yjs?: { documentManager, presenceManager }` (or a `({ clientId, connId }) => managers` factory) instead. Wire the presence transport before the document transport to preserve replay ordering.
