---
"@stratasync/transport-graphql": major
"@stratasync/client": major
"@stratasync/server": major
---

Deliver group-membership changes as durable sync actions instead of out-of-band control frames.

1.1.0 shipped `notifyGroupJoined` / `notifyGroupLeft`, which pushed `group_joined` / `group_left` frames over a second redis channel to whichever of a user's sockets happened to be open. That was lossy by construction: a user offline when a project was unshared never got the frame, and nothing else repaired it. A plain reconnect does not — the server re-resolves groups for the new session, but the client's own group list and cache are only rewritten by a bootstrap, which runs on first load or a stale cursor. So their cache kept serving rows from a group they had been removed from.

`notifyGroupsChanged(userId)` replaces both. It writes a `"G"` sync action addressed to that user's own group carrying their full current group list, recomputed from the same sources `authorizeToken` uses, then publishes it. Being an ordinary action it carries a syncId and lives in `sync_actions`, so it is delivered by the live stream, replay, catch-up and bootstrap alike — including to a user who was offline at the time.

`@stratasync/client` already understood these actions: `SyncGroupManager` partial-bootstraps added groups and drops removed ones. The engine simply never produced one. Clients that do not understand `"G"` ignore it, because the row-applying path skips actions whose model is not in the registry.

**Breaking:**

- `notifyGroupJoined(userId, groupId)` and `notifyGroupLeft(userId, groupId)` are replaced by `notifyGroupsChanged(userId)`. Call it after writing or revoking the membership; it recomputes the list itself.
- The `sync:control` redis channel, the `group_joined` / `group_left` frames, the `group-membership` subscribe capability, and the `ControlFrame` exports are gone. No capability negotiation is needed now that the change travels in-band.
- `TransportAdapter.onGroupMembershipChange` and `WebSocketManager.onGroupMembershipChange` are removed.
- `insertCreatesGroup` now requires an explicit `groupType`; the registry throws at startup instead of defaulting to the model name. That value is written to a table the consumer owns, so the engine no longer guesses it.
- A group opened by an insert is granted for the remainder of that mutate batch and committed as a membership row; it is no longer pushed back into the caller's `SyncUserContext` array. The next request picks it up through `authorizeToken`.

Also: `groupKey` is now compiled into a `resolveGroup` at registry time, so group resolution has one code path rather than two, and a non-insert mutation loads its target row once instead of twice.
