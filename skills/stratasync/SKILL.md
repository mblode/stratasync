---
name: stratasync
description: Working in an app that already runs Strata Sync: adding a model or a field on both sides, querying with hooks, mutating, sync groups and permissions, undo and redo, collaborative text with Yjs, and debugging a stuck outbox or a client that will not converge. Strata Sync is an open-source implementation of Linear's sync engine, so the vocabulary is Linear's (bootstrap, lastSyncId, delta packets, sync actions, partial indexes, the transaction queue, sync groups). Use when asked to "add a field to a synced model", "why is my data not syncing", "the outbox is stuck", "add a sync group", "make this field collaborative", "linear sync engine", or any change to a Strata Sync client or server. To create a project from nothing, use scaffold-stratasync instead.
---

# Strata Sync

Change an app that already syncs, without breaking convergence.

- **IS:** adding or changing models, fields, queries, mutations, sync groups, undo behaviour and collaborative fields in a running Strata Sync app, and diagnosing sync that has stopped working.
- **IS NOT:** creating a new project (use `scaffold-stratasync`), or editing the engine itself.

Strata Sync is a clean-room implementation of the architecture Linear published; it contains no Linear code. The [reverse-engineering notes](https://github.com/wzhudev/reverse-linear-sync-engine) are the reference for the concepts named below.

## Reference files

| File                                   | Read when                                                          |
| -------------------------------------- | ------------------------------------------------------------------ |
| `references/models-and-fields.md`      | Adding or changing a model or field; every layer that must agree   |
| `references/reading-and-writing.md`    | Querying with hooks, mutating, optimistic updates, undo and redo   |
| `references/groups-and-permissions.md` | Scoping rows to a tenant, team or user; joining and leaving groups |
| `references/debugging.md`              | Data not arriving, outbox stuck, client re-bootstrapping in a loop |

## The one rule that causes most bugs

**A field exists only where it is registered.** The sync layer filters explicitly at every hop, so a field added in one place and not the others is dropped silently, with no error anywhere. Adding a field means changing all of these in the same commit:

1. The Drizzle column on the server (plus a migration).
2. The model's `fields` and its `updateFields` set in the server model config. **A field absent from `updateFields` is silently discarded on every update.**
3. The `@Property()` on the client model class.
4. Any GraphQL projection the app maintains for its own reads.

If a value writes locally and vanishes after the server round-trip, it is almost always step 2.

## Adding a field: the checklist

```text
- [ ] Drizzle column added, migration generated and applied
- [ ] Server model config: field listed in `fields` and, if editable, in `updateFields`
- [ ] Client model: `@Property() declare name: Type;`
- [ ] Type coercion checked: date-only vs instant epochs are different encodings
- [ ] Schema hash changes, so clients re-bootstrap once. Confirm that is acceptable
- [ ] Round-trip tested: write it, reload the page, confirm it survived
```

The last line is the one that catches a missing `updateFields` entry, because everything looks correct until the reload.

## Concepts, in Linear's vocabulary

| Term          | What it means here                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lastSyncId`  | The server's monotonic counter, a **string** on the wire so it can pass `Number.MAX_SAFE_INTEGER`. The client stores its own and asks for everything after it |
| Bootstrap     | The initial load. `auto` picks full or local; `full` ignores local data; `local` reads the replica only                                                       |
| Delta packet  | A batch of sync actions (`I`, `U`, `D`, `A`, `V`, plus `C` for coverage and `G` for a group change) with a `lastSyncId` watermark                             |
| Outbox        | The durable transaction queue. `queued → sent → awaitingSync → completed`, keyed by `clientId + clientTxId` for idempotent retry                              |
| Partial index | An index key and value naming a subset of a model, with coverage recorded so the same subset is not fetched twice                                             |
| Sync group    | The permission boundary. A client only receives deltas for groups it subscribes to                                                                            |
| Rebase        | Re-applying pending local writes on top of an incoming delta, field by field                                                                                  |

## Anti-patterns

- **Never** read synced models with `fetch()` or `useEffect` + `useState`. Use the hooks; the local replica is already there and a manual fetch will not see deltas.
- **Never** mutate a model object directly and expect it to sync. Go through `client.update()` or the instance `.save()`, which records the transaction.
- **Never** add a field to the Drizzle schema alone and assume it syncs. See the checklist.
- **Never** treat `lastSyncId` as a number. It is a string, and parsing it to a `Number` loses precision once the log is large.
- **Never** skip `observer()` on a component reading MobX state. It will render once and never update.
- **Never** clear IndexedDB to "fix" sync without checking the outbox first. Unsent writes live there and clearing discards them.
