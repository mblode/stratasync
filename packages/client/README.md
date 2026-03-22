# @stratasync/client

Offline-first sync orchestration: identity maps, outbox batching, delta reconciliation, conflict resolution, undo/redo, and query execution.

## Overview

sync-client coordinates the client-side sync lifecycle:

- **SyncClient** — main orchestrator for the sync lifecycle
- **Outbox manager** — batches mutations for offline-first support
- **Identity map** — canonical in-memory object instances (deduplication via MobX reactivity)
- **Sync orchestrator** — state machine for bootstrap, delta subscription, and conflict resolution
- **History manager** — undo/redo with inverse operation tracking
- **Query execution** — predicate builders, sorting, and pagination against identity maps

## Installation

```bash
npm install @stratasync/client
```

Dependencies: `@stratasync/core`, `@stratasync/yjs`

## Usage

```typescript
import { createSyncClient } from "@stratasync/client";

const client = createSyncClient({
  storage, // StorageAdapter (e.g. sync-storage-idb)
  transport, // TransportAdapter (e.g. sync-transport-graphql)
  reactivity, // ReactivityAdapter (e.g. sync-mobx)
  schema: ModelRegistry.snapshot(),
  userId,
  groups,
});

await client.start();

// Create (optimistic by default)
await client.create("Task", {
  id: crypto.randomUUID(),
  title: "New task",
  workspaceId,
  createdAt: Date.now(),
});

// Update
await client.update("Task", taskId, {
  title: "Updated title",
});

// Delete
await client.delete("Task", taskId);

// Query
const result = await client.query("Task", {
  where: (i) => i.workspaceId === workspaceId,
  limit: 50,
});
```

## Package Structure

```
src/
  index.ts             — public API barrel export
  client.ts            — SyncClient factory and mutation coordination
  sync-orchestrator.ts — state machine: bootstrap, delta application, rebase
  outbox-manager.ts    — offline mutation queue with batching and retry
  identity-map.ts      — per-model ObservableMap with MobX reactivity
  history-manager.ts   — undo/redo stack with inverse operation tracking
  query.ts             — predicate builders and executeQuery
  types.ts             — StorageAdapter, TransportAdapter, SyncClientOptions
  utils.ts             — getModelKey, getModelData, pickOriginal helpers
```
