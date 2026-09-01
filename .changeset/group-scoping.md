---
"@stratasync/server": minor
---

Add per-row group scoping so a model can own a delta group whose membership is the access boundary.

- `resolveGroup`: an optional per-model hook that takes precedence over `groupKey`, letting a row's audience depend on the row. It receives the action, payload, existing row (non-inserts) and caller context, and returning `null` means ungrouped exactly as `groupKey: null` does.
- `insertCreatesGroup` (with `groupType`): an INSERT whose resolved group is absent from the caller's groups grants the creator that membership in the same transaction instead of being denied. This makes a model whose group is its own id insertable at all; every other action is unchanged, and writing to a group you do not belong to is still denied.
- `notifyGroupJoined` / `notifyGroupLeft` on the sync server: server-initiated `group_joined` / `group_left` control frames addressed to one user's live sessions, so a newly shared group is batch-loaded and a removed one is dropped rather than lingering. They travel over a new `sync:control` redis channel alongside the delta channel.

All three are additive and optional: a consumer that sets none behaves exactly as before. Clients that do not handle the new frames still converge on their next bootstrap.
