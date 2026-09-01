<div align="center">

# [Strata Sync](https://blode.co/stratasync)

**An open-source implementation of Linear's sync engine, for TypeScript, React and Next.js**

Every read is instant, every write survives offline, and every client converges on one server-ordered log. On your own Postgres, with no hosted service.

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
<a href="https://blode.co/stratasync/docs">
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

## Linear's sync engine, open-sourced

Linear's engineers described their sync engine in talks and posts, and the
[reverse-engineering notes](https://github.com/wzhudev/reverse-linear-sync-engine)
wrote it down chapter by chapter. Strata Sync implements each chapter in
TypeScript.

| Linear's architecture                                           | In Strata Sync                                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model registry and decorators, with per-model load strategies   | `ModelRegistry`, `@ClientModel`, `@Property`, `@Reference`, `@OneToMany` in `@stratasync/core`. `loadStrategy` is `instant`, `lazy`, `partial`, `explicitlyRequested` or `local` |
| Object pool: one instance per id                                | The client identity map, bounded by `identityMapMaxSize`                                                                                                                         |
| Bootstrap (full, partial, local) keyed by a global `lastSyncId` | `bootstrapMode`, NDJSON streamed from `/sync/bootstrap`, ending in `BootstrapMetadata`                                                                                           |
| Partial indexes and a de-duplicating batch loader               | `hasPartialIndex` / `setPartialIndex` on the storage adapter, `/sync/batch` via `createBatchLoadStream`                                                                          |
| Transaction queue with persisted state for restart replay       | `queued → sent → awaitingSync → completed`, in a durable outbox keyed by `clientId + clientTxId`                                                                                 |
| Delta packets of sync actions (I, U, D, A, V, plus C and G)     | `DeltaPacket`, `SyncAction` and `applyDeltas`, served over `/sync/deltas` and `/sync/ws`                                                                                         |
| Rebase in-flight local changes on incoming deltas               | `rebaseTransactions` with `rebaseStrategy` and `fieldLevelConflicts`                                                                                                             |
| Sync groups as the permission boundary                          | `groups` on the client, `auth.resolveGroups` on the server, membership changes as durable `"G"` actions                                                                          |
| Schema hash that triggers a local migration                     | `computeSchemaHash()`; a mismatch forces a full re-bootstrap                                                                                                                     |
| Undo and redo from transaction history                          | `client.undo()`, `client.redo()`, `runAsUndoGroup()`                                                                                                                             |

Beyond the published architecture, Strata Sync adds Yjs CRDT documents and
presence for collaborative text (`@stratasync/y-doc`), and makes storage,
transport and reactivity swappable adapters behind one interface each.

Strata Sync is a clean-room implementation of the published architecture. It
contains no Linear code, and Linear is not affiliated with or endorsing this
project.

## What you get

- **Instant reads:** every query hits a local IndexedDB replica, so there are no spinners and no round-trips.
- **Writes that survive offline:** they queue in a durable outbox and drain in order when the connection returns, with idempotency keys so a retry never applies twice.
- **Fine-grained reactivity:** MobX observables mean only the components touching changed data re-render.
- **Live collaboration and undo:** Yjs CRDTs let several people edit one document, with history tracked per transaction.
- **Swappable adapters:** storage, transport, and reactivity are each a separate package.
- **Your own backend:** `@stratasync/server` registers routes on your Fastify app and stores the sync log in your Postgres through Drizzle. Redis is optional, for fanning deltas across processes.

## In production

[Done Bear](https://donebear.com) runs on Strata Sync: a web dashboard, a Tauri
desktop shell, a SwiftUI iOS app, a CLI, a Raycast extension and a hosted MCP
server, all reading and writing one Postgres over the same bootstrap, delta and
mutate endpoints. (The iOS client is a Swift port of the protocol rather than
these npm packages.)

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
