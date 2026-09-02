# Sync groups and permissions

A sync group is the permission boundary. A client receives deltas only for the
groups it subscribes to, and the same mechanism decides what a bootstrap
returns. Replication and authorisation are one thing here, not two.

## The two sides

On the client, groups are an option:

```ts
createSyncClient({ groups: ["workspace_1", "team_9"] /* ... */ });
```

On the server, `auth.resolveGroups(userId)` returns the groups that user may
see, per request. Do not trust a group list sent by the client; resolve it from
your own membership table.

## Scoping a model

Each model declares how a row maps to a group:

```ts
Task: {
  groupKey: "workspaceId",   // a column on the row
  // ...
}
```

| Setting                   | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `groupKey: "columnName"`  | The row belongs to the group named by that column                  |
| `groupKey: "__modelId__"` | The row's own id is the group. For the group-defining model itself |
| `groupKey: null`          | Ungrouped: visible to every authenticated client                   |
| `resolveGroup(ctx)`       | Per-row resolution. Takes precedence over `groupKey`               |

`resolveGroup` receives the existing `record` for non-insert actions, and
`null` for inserts. For anything but an insert, resolve from the record rather
than the payload: the payload is whatever the caller chose to send.

Note that a composite model currently receives `record: null` even for
non-inserts, so its group resolution has only the payload to work from. Treat
that as a sharp edge when scoping join tables.

## Creating a group

Group resolution runs before the mutation, which makes a chicken-and-egg
problem for the row that defines a group: the group does not exist yet, so the
creator cannot be a member of it.

`insertCreatesGroup: true` is the escape hatch, and only for inserts. The
membership row is written inside the same transaction, so a failed insert rolls
it back.

Set it **only** on a model whose resolved group is its own id. On a model that
resolves to another row's group (a task resolving to its project), the flag
would hand anyone membership of that group simply by inserting into it. Such a
model should leave it off and be denied normally. The registry requires an
explicit `groupType` when the flag is set, because that value lands in a table
your app owns.

## Changing membership

Writing or revoking the membership row is your app's job. Afterwards, tell the
user's clients:

```ts
await syncServer.notifyGroupsChanged(userId);
```

This writes a `"G"` sync action carrying the user's full current group list and
publishes it. It is a durable action rather than a control frame, so a user who
is offline still learns about it on their next catch-up, which is the whole
point: a control frame sent to a disconnected client is simply lost.

On the client, a group action holds the cursor and forces a full re-bootstrap.
The server filters that bootstrap on the user's current membership, so it
converges in both directions: a group shared with the user arrives (its history
sits before the cursor and would never come as deltas), and a group taken away
has its rows dropped (nothing else can carry a row _out_ of a replica). The
re-bootstrap is latched in local metadata until one completes, so a client
stopped part-way, or one whose attempt failed, still owes it on the next start.
Every packet is held while it is owed, so the cursor cannot move past the
action and lose it.

A change that alters _who can see existing rows_ without changing anyone's
group list (a project turning private, a task moving into one) still needs the
server to send the affected users a group action, because a delta is published
to one group and a row leaving a group is invisible to everyone still in the
old one.

## Testing a scoping change

Group bugs are quiet: the write succeeds and the wrong person can read it. Test
from both directions.

```text
- [ ] A member of the group reads the row
- [ ] A non-member does NOT receive it in a bootstrap
- [ ] A non-member does NOT receive it in a delta
- [ ] A non-member cannot update, delete or archive it
- [ ] A row whose group column is null is not silently visible to everyone
- [ ] Leaving the group evicts the rows already on the client
```
