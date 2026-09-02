# @stratasync/storage-local

## 2.1.0

### Minor Changes

- 5322c46: Correctness pass on the client sync path, plus package metadata that says what
  these packages are.
  
  Correctness fixes:
  
  - **core**: a property serializer that returns `null` is no longer overridden by
    the raw value (`?? value` treated a legitimate `null` as "no serializer");
    leaving the NDJSON reader early — a timeout, a parse error, or a consumer
    breaking out of `for await` — now cancels the underlying stream instead of
    holding the HTTP body open behind a released reader; undoing an update sends
    an explicit `null` for fields that had no value before the change, because
    JSON drops an `undefined` member and the undo silently left the new value in
    place.
  - **client**: a transaction the server does not report on is requeued rather
    than parked in `sent` until the next reconnect; `batchIndex` is seeded from
    the persisted outbox before the first transaction is stamped, so a fresh
    runtime cannot re-issue an index another tab already used; a cancelled
    partial bootstrap no longer records its sync groups as subscribed, which made
    the next start believe half-loaded groups were complete; a failed `start()`
    clears the running flag, so the next `start()` bootstraps instead of
    returning early; a scheduled resubscribe is cancelled on reset rather than
    firing into a later run and opening a second subscription; `stop()` and
    `clearAll()` share one teardown path and wait for an in-flight `start()` to
    observe the cancelled run before storage is closed or cleared; an update
    skips `undefined` members instead of diverging optimistic state from what the
    server was sent.
  - **client (behaviour change)**: a sync-group action (`"G"`/`"S"`) now holds the
    cursor and forces a full re-bootstrap, matching the Swift client, instead of
    diffing the group list. The diff could not converge: an unchanged list was a
    no-op, so a row that left the user's audience without their groups changing
    stayed cached; a removed group was evicted by the model's `groupKey` index,
    which finds nothing when rows carry a per-row group; and a partial bootstrap
    for a non-workspace group was scoped by a consumer's workspace filter and
    returned nothing. The re-bootstrap is latched in `StorageMeta.groupChangePending`
    until one completes, so stop/start and a failed attempt still owe it, and no
    packet is applied while it is owed so the action cannot be lost. There is no
    partial-bootstrap path for group changes any more.
  - **server**: a client whose cursor sits exactly one below the oldest retained
    sync action is no longer sent through a full bootstrap — the next action it
    needs is the earliest one kept.
  
  Metadata:
  
  - Every package now carries a `description`, `keywords`, `homepage`, `license`,
    `author`, `engines`, `sideEffects` and `publishConfig.provenance`, and ships
    `src` alongside `dist` so source maps resolve. `@stratasync/react` marks `yjs`
    as an optional peer dependency.

### Patch Changes

- 26bec74: Bump published-package dependencies from the Dependabot npm_and_yarn group. `@stratasync/server` now depends on `uuid` ^14.0.2 (used for deterministic composite IDs) and updates Fastify/`ws` test pins. The `@stratasync/next` Next.js peer range stays `^14 || ^15 || ^16`.
- Updated dependencies [26bec74]
- Updated dependencies [5322c46]
  - @stratasync/core@2.1.0
  - @stratasync/client@2.1.0

## 2.0.0

### Patch Changes

- Updated dependencies [b8ccaf8]
  - @stratasync/client@2.0.0
  - @stratasync/core@2.0.0

## 1.1.0

### Patch Changes

- Updated dependencies [6a790bf]
  - @stratasync/client@1.1.0
  - @stratasync/core@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [4c4fc35]
  - @stratasync/core@1.0.0
  - @stratasync/client@1.0.0

## 0.6.0

### Patch Changes

- Updated dependencies [d10cce1]
  - @stratasync/client@0.6.0
  - @stratasync/core@0.6.0

## 0.5.1

### Patch Changes

- e261dcb: Point `repository`, `bugs`, and `homepage` at `github.com/mblode/stratasync`. The repo moved out of the `stratasync` org, and package metadata is frozen at publish time, so the Repository link on npm kept pointing at the old path. The npm scope is unchanged.
- Updated dependencies [e261dcb]
  - @stratasync/core@0.5.1
  - @stratasync/client@0.5.1

## 0.5.0

### Minor Changes

- 6c61060: Repo-wide correctness and simplification pass.

  Correctness fixes:

  - **core**: parse an `end` bootstrap line carrying `lastSyncId` as an end line
    (was misread as metadata); flush the NDJSON decoder at EOF so a trailing
    multi-byte character is not dropped; retry a rejected cached reference instead
    of replaying the rejection.
  - **server**: allocate sync-action ids in commit order via a per-table advisory
    lock, closing a gap where a late-committing lower id could be permanently
    dropped for live subscribers; **security** — reject group-keyed
    UPDATE/DELETE/ARCHIVE/UNARCHIVE whose group column is null (previously skipped
    authorization and broadcast the write to every tenant).
  - **client**: apply optimistic unarchive without destroying the class instance;
    complete transactions immediately when the mutate result carries no sync id
    (previously parked forever); emit a `modelChange` when the identity map evicts
    an entry so hooks re-render and Suspense re-hydrates.
  - **storage-local**: a single corrupted stored value no longer permanently
    bricks the adapter; writes surface quota errors as a typed `StorageQuotaError`.
  - **transport-graphql**: fail active subscriptions when reconnect retries are
    exhausted (iterators previously hung forever).
  - **react**: provider render is now side-effect free; `useQuery` resets its
    state when the model name changes.
  - **next**: bootstrap prefetch no longer produces an unhandled rejection when
    the stream rejects after the timeout wins.

  Behavioral / API changes:

  - `SyncDb` now requires an `execute()` method.
  - `SyncDao.getLastSyncId` removed (unused).
  - `CachedPromise` gains an optional `referenceId`; assigning a pending or empty
    cached reference now writes/clears the foreign key (previously a silent no-op).
  - `IdentityMap`/`IdentityMapRegistry` gain an optional `onEvict` callback.
  - Bootstrap `returnedModelsCount` now reflects rows in scope at the snapshot
    (informational; pre touched-filter).

  Also: y-doc clamps retry delay after jitter and extracts ProseMirror content
  helpers; mobx and server shed unreachable code paths.

### Patch Changes

- Updated dependencies [6c61060]
  - @stratasync/client@0.5.0
  - @stratasync/core@0.5.0

## 0.4.0

### Minor Changes

- f61c751: Client decomposition follow-up (wire protocol unchanged).

  - The sync orchestrator is split into focused modules (`sync/delta-pipeline`, `sync/bootstrap-runner`, `sync/sync-groups`, plus shared pending-hydration/context); the orchestrator file drops from ~1630 to ~520 LOC and is now lifecycle + wiring. All replay-barrier, deferred-rollback, echo-suppression, cursor-monotonic, and group-change invariants are preserved (the 43-test sync-engine suite is unchanged).
  - `client.ts` is decomposed into a `MutationCoordinator` (table-driven mutations, no more self-reference hack), `LazyLoader`, and `materializer`; the facade drops from ~1300 to ~810 LOC.
  - **Breaking:** the client no longer imports `@stratasync/y-doc` at runtime. `SyncClientOptions.yjsTransport` is removed; pass `yjs?: { documentManager, presenceManager }` (or a `({ clientId, connId }) => managers` factory) instead. Wire the presence transport before the document transport to preserve replay ordering.

### Patch Changes

- Updated dependencies [f61c751]
  - @stratasync/core@0.4.0
  - @stratasync/client@0.4.0

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
- Updated dependencies [a4e68fc]
- Updated dependencies [f0bfee6]
  - @stratasync/core@0.3.0
  - @stratasync/client@0.3.0

## 0.1.2

### Patch Changes

- 5dfea7c: Bump version to fix npm publish conflict
