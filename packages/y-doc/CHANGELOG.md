# @stratasync/y-doc

## 0.4.0

### Minor Changes

- f61c751: Client decomposition follow-up (wire protocol unchanged).

  - The sync orchestrator is split into focused modules (`sync/delta-pipeline`, `sync/bootstrap-runner`, `sync/sync-groups`, plus shared pending-hydration/context); the orchestrator file drops from ~1630 to ~520 LOC and is now lifecycle + wiring. All replay-barrier, deferred-rollback, echo-suppression, cursor-monotonic, and group-change invariants are preserved (the 43-test sync-engine suite is unchanged).
  - `client.ts` is decomposed into a `MutationCoordinator` (table-driven mutations, no more self-reference hack), `LazyLoader`, and `materializer`; the facade drops from ~1300 to ~810 LOC.
  - **Breaking:** the client no longer imports `@stratasync/y-doc` at runtime. `SyncClientOptions.yjsTransport` is removed; pass `yjs?: { documentManager, presenceManager }` (or a `({ clientId, connId }) => managers` factory) instead. Wire the presence transport before the document transport to preserve replay ordering.

## 0.3.0

### Minor Changes

- a4e68fc: Gold-standard refactor. The on-the-wire protocol is unchanged — 0.2.x clients and servers interoperate with 0.3.0 — but several TypeScript APIs changed, so this is a breaking (minor, under 0.x) coordinated release.

  **Core**

  - New `@stratasync/core/protocol`: one source of truth for NDJSON/bootstrap/delta parsing (`readNdjsonLines`, `parseBootstrapLine`, `parseDeltaPacket`, `parseSyncAction`, `normalizeBootstrapMetadata`, `finalizeBootstrapMetadata`), replacing three drifted parser copies in transport-graphql and next.
  - `parseSyncId` moved here (strict string-only — sync IDs stay strings on the wire for precision safety).
  - Pure rebase helpers `rebaseOriginals` / `resolveConflictEffect` and the model `serializeModelRecord` / `deserializeModelRecord` codec moved out of the client into core.

  **Client**

  - `OutboxManager.confirmFromActions` now owns delta confirmation (fixes a slow `localClientTxIds` leak); orchestrator concurrency moved from hand-rolled promise-chain locks to `AsyncQueue`/`Gate` (errors surface instead of wedging sync); `SyncStateMachine` and `SyncCursor` extracted from the orchestrator.
  - O(1) identity-map LRU eviction (was O(n²)).
  - New `StorageQuotaError` and `StorageAdapter.pruneSyncActions(beforeSyncId)`; storage adapters surface quota errors and the orchestrator prunes the sync-actions store below the bootstrap floor. IndexedDB gains a `migrations` hook.

  **Server**

  - `sync-websocket` god-module split into `client-session` / `replay` / `messages` / `heartbeat` + a thin registration; fixes a delta-subscription leak when a socket closes mid-subscribe.
  - Shared `auth/authorize` removes the 3× token-verify / 2× group-resolution duplication; bootstrap cursor streaming unified behind `CursorStrategy`; delta pub/sub collapsed from five classes to `DeltaBus` + `RedisDeltaTransport`; internal `core/` (bigint `SyncId`, single `RawSyncActionRow`, guards, json, errors). The delta-factory exports were renamed; the documented server entry points are unchanged.

  **React / Next**

  - Removed the redundant combined `SyncContext` (kept the three split contexts), eliminating backlog-churn re-renders.
  - `seedStorageFromBootstrap` refuses to seed when the snapshot has no `schemaHash` unless `validateSchemaHash: false`.

  **Repo**

  - Unified tsconfigs, standardized package scripts, all suites on Vitest, root-only lint, and a changesets `fixed` group so the packages always release in lockstep.

### Patch Changes

- f0bfee6: Repo hygiene: standardized build/test/check-types scripts and tsconfigs across all packages, migrated the remaining `node:test` suites to Vitest, hoisted lint tooling to the root, and pinned all published packages into one coordinated release group. No runtime or API changes.

## 0.2.5

### Patch Changes

- b4f4433: Fix description seeding: seed from canonical content when the Yjs prosemirror fragment has no derived text, not only when it is completely empty. A stray empty paragraph (written by the editor on mount before half-synced text-bearing updates arrive) no longer blocks canonical seeding, so a freshly-opened client renders the description instead of a blank editor.

## 0.2.4

### Patch Changes

- a18b3c8: Fix sync cursor advancement, own-echo rebase handling, Yjs initial content and presence cleanup, React stale query/client state, authenticated bootstrap retry, delta pagination guards, and IndexedDB empty batch handling.

## 0.2.3

### Patch Changes

- 3f7626e: Bug fixes and improvements across all packages

## 0.2.2

### Patch Changes

- 7e2a573: stratasync

## 0.2.1

### Patch Changes

- Initial patch release
