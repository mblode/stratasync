# Strata Sync

Sync that works offline.

A local-first sync engine for TypeScript, React, and Next.js. Every read is instant. Every write works offline. Every client converges.

## Why Strata Sync

Linear described a sync architecture that became the gold standard for local-first apps but never open-sourced it. Strata Sync is an independent implementation of that protocol — monotonic sync log, bootstrap + delta streaming, optimistic outbox, field-level LWW rebase — extended with Yjs CRDT collaboration, undo/redo, and pluggable adapters.

## Features

- **Instant reads** — Local IndexedDB replica. No spinners, no round-trips.
- **Offline support** — Persistent outbox. Changes sync when you reconnect.
- **Fine-grained reactivity** — MobX observables. Only affected components re-render.
- **Real-time collaboration** — Yjs CRDT for rich text and structured data.
- **Undo and redo** — Transaction-based history tracking.
- **Modular** — Swap storage, transport, or reactivity adapters.

## Quick Start

```bash
npm install @stratasync/core @stratasync/client @stratasync/react
```

```typescript
import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("Todo", { loadStrategy: "instant" })
class Todo extends Model {
  @Property() declare title: string;
  @Property() declare completed: boolean;
}
```

```tsx
import { useQuery, useSyncClient } from "@stratasync/react";

function TodoList() {
  const { data: todos } = useQuery("Todo", {
    where: (t) => !t.completed,
  });
  const { client } = useSyncClient();

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
      <button
        onClick={() =>
          client.create("Todo", {
            title: "New todo",
            completed: false,
          })
        }
      >
        Add
      </button>
    </ul>
  );
}
```

## Packages

`core` | `client` | `react` | `mobx` | `y-doc` | `next` | `storage-idb` | `transport-graphql` | `server`

## License

[MIT](LICENSE.md)
