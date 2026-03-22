# @stratasync/react

React bindings and hooks for the sync engine.

## Overview

sync-react provides React hooks for data fetching, real-time updates, and collaborative editing:

- **SyncProvider** — context provider for the sync client
- **useModel / useQuery** — data fetching with Suspense or loading states
- **useConnectionState** — monitor sync connection status
- **useYjsDocument / useYjsPresence** — collaborative editing and presence

## Installation

```bash
npm install @stratasync/react
```

Peer dependencies: `react` ^18.0.0 || ^19.0.0, `yjs` ^13.6.0 (for collaborative features)

## Setup

Wrap your app with `SyncProvider`:

```tsx
import { SyncProvider } from "@stratasync/react";

function App() {
  return (
    <SyncProvider config={syncConfig}>
      <YourApp />
    </SyncProvider>
  );
}
```

## Hooks

### Data Fetching

```typescript
// Single model with Suspense (throws promise while loading)
const task = useModel("Task", taskId);

// Single model with loading state (no Suspense)
const { data: task, isLoading } = useQuery("Task", {
  where: (i) => i.id === taskId,
});

// Filtered query
const { data: tasks, isLoading } = useQuery("Task", {
  where: (i) => i.workspaceId === workspaceId && !i.completedAt,
  limit: 50,
});

// Skip query conditionally
const { data } = useQuery("Task", { skip: !workspaceId });
```

### Connection State

```typescript
const { state, isReady, isSyncing, isOffline } = useConnectionState();
// state: "idle" | "loading" | "syncing" | "error"
```

### Collaborative Editing (Yjs)

```typescript
const { doc, isConnected, participants, content } = useYjsDocument(
  { entityType: "Task", entityId: taskId, fieldName: "description" },
  { autoConnect: true }
);
```

## Package Structure

```
src/
├── hooks/
│   ├── use-sync-client.ts       — Access SyncClient instance
│   ├── use-model.ts             — Single model (Suspense)
│   ├── use-query.ts             — Filtered queries
│   ├── use-connection-state.ts  — Connection monitoring
│   ├── use-yjs-document.ts      — Collaborative editing
│   └── use-yjs-presence.ts      — Presence tracking
├── provider.tsx                 — SyncProvider component
├── context.ts                   — React context
└── types.ts                     — Type definitions
```
