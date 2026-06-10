# @stratasync/server

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

- da88949: Align partial bootstrap and client hydration with Linear-style sync engine semantics.

## 0.2.4

### Patch Changes

- c395205: Thread SyncUserContext through mutation lifecycle hooks (onBeforeInsert, onBeforeUpdate, onBeforeDelete) to enable permission checks and audit logging

## 0.2.3

### Patch Changes

- 3f7626e: Bug fixes and improvements across all packages

## 0.2.2

### Patch Changes

- 7e2a573: stratasync

## 0.2.1

### Patch Changes

- Initial patch release
