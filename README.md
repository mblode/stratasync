<div align="center">

# [Strata Sync](https://stratasync.dev)

**A local-first sync engine for TypeScript, React, and Next.js, built on the architecture Linear never open-sourced**

Every read is instant, every write works offline, and every client converges.

<p align="center">
  <a href="https://github.com/mblode/stratasync/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/mblode/stratasync?style=flat&colorA=000000&colorB=000000" />
  </a>
</p>

</div>
## Why Strata Sync

Linear built a sync architecture that became the gold standard for local-first apps, but never open-sourced it. [Strata Sync](https://stratasync.dev) is an open-source implementation of that architecture, extended with Yjs CRDT collaboration, undo/redo, and pluggable adapters.

## Features

- **Instant reads**: Local IndexedDB replica. No spinners, no round-trips.
- **Offline support**: Writes queue offline and sync when you reconnect.
- **Fine-grained reactivity**: MobX observables. Only affected components re-render.
- **Real-time collaboration**: Multiple users edit the same document with Yjs.
- **Undo and redo**: Transaction-based history tracking.
- **Modular**: Swap storage, transport, or reactivity adapters.

## Quickstart

Scaffold a full-stack app with the Claude Code skill:

```bash
npx skills add stratasync/stratasync
```

Or install the packages manually:

```bash
npm install @stratasync/core @stratasync/client @stratasync/react @stratasync/mobx @stratasync/storage-idb @stratasync/transport-graphql
```

### 1. Define your models (`lib/sync/models.ts`)

```typescript
import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("Todo", { loadStrategy: "instant" })
class Todo extends Model {
  @Property() declare title: string;
  @Property() declare completed: boolean;
}
```

### 2. Create the client (`lib/sync/client.ts`)

```typescript
import { createSyncClient } from "@stratasync/client";
import { createMobXReactivity } from "@stratasync/mobx";
import { createIndexedDbStorage } from "@stratasync/storage-idb";
import { GraphQLTransportAdapter } from "@stratasync/transport-graphql";

const client = createSyncClient({
  storage: createIndexedDbStorage(),
  transport: new GraphQLTransportAdapter({
    endpoint: "/api/graphql",
    syncEndpoint: "/api/sync",
    wsEndpoint: "wss://api.example.com/sync/ws",
    auth: { getAccessToken: async () => "token" },
  }),
  reactivity: createMobXReactivity(),
});
```

### 3. Build reactive components (`components/todo-list.tsx`)

```tsx
import { observer } from "mobx-react-lite";
import { useQuery, useSyncClient } from "@stratasync/react";

const TodoList = observer(() => {
  const { data: todos } = useQuery("Todo", {
    where: (t) => !t.completed,
  });
  const { client } = useSyncClient();

  const addTodo = async () => {
    const todo = await client.create("Todo", {
      title: "New todo",
      completed: false,
    });
    todo.title = "Actually, a better title";
    await todo.save();
  };

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
      <button onClick={addTodo}>Add</button>
    </ul>
  );
});
```

### Documentation

Full documentation at [stratasync.dev/docs](https://stratasync.dev/docs).

## Packages

`core` | `client` | `react` | `mobx` | `y-doc` | `next` | `storage-idb` | `transport-graphql` | `server`

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
