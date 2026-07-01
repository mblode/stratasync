# @stratasync/client

Offline-first sync orchestration: identity maps, outbox batching, delta reconciliation, conflict resolution, undo/redo, and query execution.

## Commands

- `npm run build`: compile TypeScript (`tsc -p tsconfig.build.json`)
- `npm run dev`: watch mode (`tsc --watch -p tsconfig.build.json`)
- `npm run test`: run tests (`vitest run`)
- `npm run lint`: lint with Oxlint
- `npm run check-types`: type check without emitting

## Architecture

```
src/
  index.ts              public API barrel export
  client.ts             SyncClient factory: wires the pieces, model loading, events
  mutations.ts          MutationCoordinator: mutation lifecycle (optimistic apply,
                        outbox enqueue, history entry) — extracted from client.ts
  loader.ts             lazy model loading and hydration entry points
  materializer.ts       builds model instances into the identity maps
  sync-orchestrator.ts  state machine: bootstrap, subscribe, delta application, rebase
  sync/                 orchestrator internals, split by concern
    bootstrap-runner.ts   bootstrap streaming + apply
    delta-pipeline.ts     delta reconciliation + pending replay
    pending-hydration.ts  re-apply pending outbox txs onto identity maps
    cursor.ts             sync-id cursor tracking
    sync-groups.ts        multi-tenant group membership
    context.ts / state.ts shared orchestrator context + state
  outbox-manager.ts     offline mutation queue with batching and retry
  identity-map.ts       per-model ObservableMap + registry (with onEvict)
  history-manager.ts    undo/redo stack with inverse operation tracking
  query.ts              predicate builders (eq, neq, gt, lt, isIn, and, or, not) + executeQuery
  types.ts              StorageAdapter, TransportAdapter, SyncClientOptions, SyncClientEvent
  errors.ts             typed client errors
  utils.ts              getModelKey, getModelData, pickOriginal helpers
  internal/             async-queue.ts, gate.ts (concurrency primitives)

tests/
  client.test.ts                     factory wiring and public API
  outbox-manager.test.ts             queue, batching, sync-id completion
  identity-map.test.ts               dedup, reactivity, eviction (onEvict)
  pending-hydration.test.ts          optimistic re-apply preserves instances
  history-manager.test.ts            undo/redo entry building
  rebase-integration.test.ts         conflict detection and resolution
  sync-engine.test.ts                full sync lifecycle: bootstrap to steady-state
  internal/                          async-queue and gate primitives
```

### Data flow

**Mutation path**: `client.create()` → optimistic identity map update → outbox queue → batch send → server confirms via delta → outbox cleared

**Server delta path**: transport subscription → `DeltaPacket` → rebase pending mutations → apply to storage → batch identity map ops + re-apply pending → emit events

**Conflict path**: rebase detects conflict → defer rollback → batch: rollback + server merge + pending re-apply → emit `rebaseConflict` event

### Sync state machine

`disconnected` → `connecting` → `bootstrapping` → `syncing` ↔ `error`

### Outbox transaction states

`queued` → `sent` → `awaitingSync` → completed (removed). On error: `sent` → `queued` (retry on reconnect). When a mutate result carries **no** sync id, the transaction skips `awaitingSync` and completes immediately.

## Gotchas

- Uses `tsconfig.build.json` for builds (not `tsconfig.json`). The build config excludes test files.
- Depends on `@stratasync/core` and `@stratasync/y-doc`, both of which must be built first (`npm run build` from root handles this via Turbo).
- Tests use **Vitest**, not Node's built-in test runner. Test mocks use `InMemoryStorage` and `TestTransport` (defined inline in test files), not shared fixtures.
- IMPORTANT: **Identity map batching is critical.** All delta application wraps identity map ops in `batch()` so MobX observers see server state + pending optimistic state atomically. Breaking this causes UI flashing during conflict resolution.
- **Never create model instances outside the identity map.** Use `client.create()` or let the orchestrator hydrate from deltas. The identity map deduplicates instances and wires MobX reactivity.
- **Conflict rollbacks are deferred.** Conflicts detected during rebase are NOT applied immediately. They collect as deferred ops and execute inside the identity map batch before server merge, preventing visible intermediate states.
- **Own-client echo suppression**: `modelChange` events are NOT emitted for confirmed optimistic updates from this client, but cross-tab updates (same clientId, different instance) DO emit events.
- **Outbox survives bootstrap.** Full bootstrap clears model and metadata storage but preserves the outbox, so unsynced mutations survive schema resets.
- `"sent"` transactions reset to `"queued"` on reconnect. This prevents lost mutations but can cause duplicate sends if the server already processed them.
- **Mutations run through `MutationCoordinator` (`mutations.ts`).** `client.ts` wires it up and delegates; there is no `clientRef` late-binding hack any more.
- **Eviction emits a `modelChange`.** When the identity map evicts an entry (LRU pressure), it invokes `onEvict`, which the client turns into a `modelChange` "update" so hooks re-render and Suspense re-hydrates on next access. `missingModels` is cleared, not poisoned.
- **Sync-less mutate results complete immediately** (see the outbox state note above) rather than parking forever in `awaitingSync`.
- `pickOriginal()` captures only changed fields, not the full model. Original baselines must be minimal for efficient conflict resolution.
- Query `includeArchived` defaults to `false`. Archived models are filtered from `getAll()` and `query()` unless explicitly included.
- Yjs integration is optional. `yjsTransport` in `SyncClientOptions` enables collaborative editing. Without it, offline-first sync still works.
- **Known deferred limitations (by design):** own-client echo suppression is intentional and all-or-nothing (confirmed optimistic updates from this client do not re-emit); cross-tab read-modify-write races on shared storage are inherent to lightweight storage adapters and are not arbitrated here.

## Conventions

- `createSyncClient(options)` is the only entry point. It returns an immutable `SyncClient` object with bound methods (closure pattern, no class).
- All mutations follow: optimistic update → outbox queue → history entry (`create`, `update`, `delete`, `archive`, `unarchive`).
- Effective change detection: only fields that actually differ (via `Object.is`) are queued. Unchanged values are skipped.
- Queries execute against in-memory identity maps, supporting `where` predicates, `orderBy` sort functions, and `limit`/`offset` pagination.
- Use predicate builders (`eq`, `neq`, `gt`, `lt`, `isIn`, `contains`, `matches`, `and`, `or`, `not`) for type-safe query construction.
- Undo/redo creates inverse operations (INSERT↔DELETE, UPDATE↔UPDATE with swapped payload, ARCHIVE↔UNARCHIVE). History entries associate with transaction IDs for conflict cleanup.
- Adapter interfaces (`StorageAdapter`, `TransportAdapter`) are defined in `types.ts`. Implementations live in separate packages (`sync-storage-idb`, `sync-transport-graphql`).
- Sync groups enable multi-tenancy. Group changes trigger re-bootstrap and subscription restart.
- Outbox entries are ordered and must be replayed in sequence on reconnect.
- Rebase strategy defaults to `"server-wins"`, where conflicting local mutations are rolled back. `"client-wins"` and `"merge"` update the original baseline instead.
- Field-level conflict detection is on by default (`fieldLevelConflicts: true`). Non-overlapping field changes on the same entity do NOT conflict.

## Downstream consumers

- `@stratasync/react`: React hooks (`useModel`, `useQuery`) via `useSyncExternalStore`
- `@stratasync/next`: Next.js provider wrapper with loading/error states
- `@stratasync/storage-idb`: implements `StorageAdapter` with IndexedDB
- `@stratasync/transport-graphql`: implements `TransportAdapter` with GraphQL + WebSocket
- `manage-frontend`: instantiates client per user account with MobX reactivity
