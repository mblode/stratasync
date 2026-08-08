<div align="center">

# [Strata Sync](https://blode.co/stratasync)

**A local-first sync engine for TypeScript, React, and Next.js, built on the architecture Linear never open-sourced**

Every read is instant, every write works offline, and every client converges.

<p align="center">
  <a href="https://www.npmjs.com/package/@stratasync/core">
    <img src="https://img.shields.io/npm/v/@stratasync/core?style=flat&colorA=000000&colorB=000000" />
  </a>
  <a href="https://github.com/mblode/stratasync/blob/main/LICENSE.md">
    <img src="https://img.shields.io/github/license/mblode/stratasync?style=flat&colorA=000000&colorB=000000" />
  </a>
</p>

</div>

## Docs

Models, adapters, and the sync protocol, with a full API reference.

<p>
<a href="https://stratasync.blode.md/docs">
<img alt="Read the docs" src=".github/assets/documentation.svg" width="200" />
</a>
</p>

## Install

```bash
npm install @stratasync/core @stratasync/client @stratasync/react @stratasync/mobx @stratasync/storage-idb @stratasync/transport-graphql
```

## Quickstart

Three files. Or run `npx skills add mblode/stratasync` and let the skill
scaffold them for you.

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

  const addTodo = () =>
    client.create("Todo", { title: "New todo", completed: false });

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

## What you get

- **Instant reads:** every query hits a local IndexedDB replica, so there are no spinners and no round-trips.
- **Writes that survive offline:** they queue locally and sync when the connection returns.
- **Fine-grained reactivity:** MobX observables mean only the components touching changed data re-render.
- **Live collaboration and undo:** Yjs CRDTs let several people edit one document, with history tracked per transaction.
- **Swappable adapters:** storage, transport, and reactivity are each a separate package.

## Packages

Ten packages, so you install only the layers you use. Runnable examples live in
[`examples/web`](examples/web) and [`examples/api`](examples/api).

|                                                   |                                               |
| ------------------------------------------------- | --------------------------------------------- |
| [`core`](packages/core)                           | Models, properties, and the sync protocol     |
| [`client`](packages/client)                       | The sync client and its lifecycle             |
| [`react`](packages/react)                         | `useQuery`, `useSyncClient`, and the provider |
| [`next`](packages/next)                           | Next.js App Router integration                |
| [`mobx`](packages/mobx)                           | MobX reactivity adapter                       |
| [`y-doc`](packages/y-doc)                         | Yjs CRDT documents for collaborative fields   |
| [`server`](packages/server)                       | The sync server and delta packet endpoints    |
| [`storage-idb`](packages/storage-idb)             | IndexedDB replica for the browser             |
| [`storage-local`](packages/storage-local)         | In-memory replica for tests and SSR           |
| [`transport-graphql`](packages/transport-graphql) | GraphQL transport over HTTP and WebSocket     |

## License

MIT

---

Crafted by [<img src="https://blode.co/avatar-circle.png" width="20" align="top" />](https://blode.co) [Matthew Blode](https://blode.co)
