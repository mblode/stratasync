# Reading and writing

## Reading

Reads hit the local replica, so there is no loading state to design around
after the first bootstrap.

```tsx
import { observer } from "mobx-react-lite";
import { useQuery, useModel, useSyncClientInstance } from "@stratasync/react";

const TaskList = observer(() => {
  const { data: tasks, isLoading } = useQuery<Task>("Task", {
    where: (t) => !t.completed,
    orderBy: (a, b) => b.createdAt - a.createdAt,
    limit: 50,
  });
  // ...
});
```

`observer()` is not optional. A component that reads MobX state without it
renders once and then never updates, which looks exactly like sync being
broken.

### The hooks

| Hook                                             | Returns                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `useQuery`                                       | A filtered list plus `isLoading`                |
| `useQueryAll`                                    | Every row of a model                            |
| `useQueryCount`                                  | A count without materialising rows              |
| `useModel`                                       | One row by id, Suspense-based                   |
| `useModelState`                                  | One row by id with an explicit loading state    |
| `useModelSuspense`                               | One row, always suspending                      |
| `useSyncClientInstance`                          | The client, for mutations                       |
| `useConnectionState` / `useIsOffline`            | Transport state                                 |
| `usePendingCount`                                | Unsent outbox entries, for a "saving" indicator |
| `useSyncReady` / `useSyncState` / `useSyncError` | Lifecycle                                       |

`where` and `orderBy` are plain functions. There are no operator helpers to
import; write JavaScript.

## Writing

Writes are optimistic: they land in the identity map immediately and queue in
the outbox for the server.

```ts
const client = useSyncClientInstance();

await client.create("Task", {
  id: crypto.randomUUID(),
  title: "New task",
  completed: false,
});

// Pass only the fields that changed.
await client.update("Task", taskId, { completed: true });

await client.delete("Task", taskId);
await client.archive("Task", taskId);
await client.unarchive("Task", taskId);
```

Ids are caller-supplied. Generate a UUID, or a deterministic id when two
clients must agree on it without coordinating.

Because the local update already happened, prefer fire-and-forget with a
rollback rather than blocking the UI on the promise:

```ts
client.update("Task", task.id, { title: next }).catch(() => {
  // surface the failure; the client has already rolled the value back
});
```

An `undefined` value in an update payload is skipped, not applied. JSON drops
it, so the server would never see it and the local state would drift. Clear a
field with `null`.

## Undo and redo

```ts
client.undo();
client.redo();
client.canUndo;
client.canRedo;

await client.runAsUndoGroup(async () => {
  await client.update("Task", id, { completed: true });
  await client.update("Project", pid, { completedCount: n + 1 });
});
```

Undo sends the inverse as an ordinary transaction, so it syncs and other
clients see a normal update. `runAsUndoGroup` collapses several mutations into
one undoable step. A server rejection drops the entry from both stacks, so undo
never replays a write the server refused.

## Collaborative text

Long-form text is the case a server-ordered log handles badly, so it uses Yjs
instead.

```tsx
import { useYjsDocument, useYjsPresence } from "@stratasync/react";
```

This needs `yjs` managers passed as the client's `yjs` option. Without them the
client still works; `client.yjs` is simply absent.
