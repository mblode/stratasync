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
  client.ts             SyncClient factory, mutation coordination, model loading (930 lines)
  sync-orchestrator.ts  state machine: bootstrap, subscribe, delta application, rebase (1306 lines)
  outbox-manager.ts     offline mutation queue with batching and retry (408 lines)
  identity-map.ts       per-model ObservableMap with MobX reactivity (307 lines)
  history-manager.ts    undo/redo stack with inverse operation tracking (197 lines)
  query.ts              predicate builders (eq, neq, gt, lt, isIn, and, or, not) and executeQuery (224 lines)
  types.ts              StorageAdapter, TransportAdapter, SyncClientOptions, SyncClientEvent (458 lines)
  utils.ts              getModelKey, getModelData, pickOriginal helpers (34 lines)

tests/
  history-manager.test.ts            undo/redo entry building (3 tests)
  rebase-integration.test.ts         conflict detection and resolution (8 tests)
  sync-engine.test.ts                full sync lifecycle: bootstrap to steady-state (14 tests)
```

### Data flow

**Mutation path**: `client.create()` → optimistic identity map update → outbox queue → batch send → server confirms via delta → outbox cleared

**Server delta path**: transport subscription → `DeltaPacket` → rebase pending mutations → apply to storage → batch identity map ops + re-apply pending → emit events

**Conflict path**: rebase detects conflict → defer rollback → batch: rollback + server merge + pending re-apply → emit `rebaseConflict` event

### Sync state machine

`disconnected` → `connecting` → `bootstrapping` → `syncing` ↔ `error`

### Outbox transaction states

`queued` → `sent` → `awaitingSync` → completed (removed). On error: `sent` → `failed` → `queued` (retry, max 5).

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
- **`clientRef` is late-bound.** The SyncClient closure assigns `clientRef` after the object literal is defined. Calling any method before `createSyncClient()` returns will throw.
- `pickOriginal()` captures only changed fields, not the full model. Original baselines must be minimal for efficient conflict resolution.
- Query `includeArchived` defaults to `false`. Archived models are filtered from `getAll()` and `query()` unless explicitly included.
- Yjs integration is optional. `yjsTransport` in `SyncClientOptions` enables collaborative editing. Without it, offline-first sync still works.

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
