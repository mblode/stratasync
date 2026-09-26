---
---

Swift SDK (no npm package change): a routine re-bootstrap (schema-hash change, cursor too old) and a group change that only adds groups no longer quarantine cached rows. Launches after an interrupted replacement now hydrate the previous snapshot instead of showing an empty store until a network bootstrap succeeds. A group change that removes a group, or whose group sets are unknown, still quarantines durably. `StorageMeta` gains `authoritativeGroups`. `SyncEngine.onEvent` is new, and `SyncClientEvent` gains `bootstrapStarted`, `bootstrapFinished`, `bootstrapFailed`, `quarantineEntered`, `quarantineCleared` and `localHydration`. Consumers that switch over `SyncClientEvent` exhaustively need a `default` branch or the new cases.
