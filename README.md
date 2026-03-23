# Strata Sync

Sync that works offline.

A local-first sync engine for TypeScript, React, and Next.js. Every read is instant. Every write works offline. Every client converges.

## Why Strata Sync

Linear built a sync architecture that became the gold standard for local-first apps, but never open-sourced it. [Strata Sync](https://stratasync.dev) is an open-source implementation of that architecture, extended with Yjs CRDT collaboration, undo/redo, and pluggable adapters. Powers [Done Bear](https://donebear.com).

## Features

- **Instant reads**: Local IndexedDB replica. No spinners, no round-trips.
- **Offline support**: Writes queue offline and sync when you reconnect.
- **Fine-grained reactivity**: MobX observables. Only affected components re-render.
- **Real-time collaboration**: Multiple users edit the same document with Yjs.
- **Undo and redo**: Transaction-based history tracking.
- **Modular**: Swap storage, transport, or reactivity adapters.

## Quick Start

Scaffold a full-stack app with the Claude Code skill:

```bash
npx skills add stratasync/stratasync
```

Or install the packages manually:

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

### Documentation

Full documentation at [stratasync.dev/docs](https://stratasync.dev/docs).

## Packages

`core` | `client` | `react` | `mobx` | `y-doc` | `next` | `storage-idb` | `transport-graphql` | `server`

## License

[MIT](LICENSE.md)
