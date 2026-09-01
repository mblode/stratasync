---
"@stratasync/transport-graphql": minor
"@stratasync/client": minor
"@stratasync/server": minor
---

Gate group membership control frames on a client-declared capability, and handle them in the web client.

The server now only sends `group_joined` / `group_left` to a connection whose `subscribe` frame declared the `group-membership` capability. This is a compatibility requirement, not politeness: a client that predates these frames may treat an unrecognized frame as a protocol error and drop the connection, so emitting one unconditionally would churn already-installed clients that cannot be upgraded. Only the outbound frame is gated — the membership change is still applied to the session's delta scope, so a removed member stops receiving that group's live edits regardless of what their client can parse.

`@stratasync/transport-graphql` declares the capability, parses both frames, and exposes them via `onGroupMembershipChange`. `@stratasync/client` routes them into the existing `SyncGroupManager`, which already partial-bootstraps added groups and drops removed ones — so a newly shared group is loaded immediately rather than waiting for the next bootstrap, and an unshared group's rows are dropped rather than lingering.

`TransportAdapter.onGroupMembershipChange` is optional, so transports that predate this keep type-checking and simply converge on the next bootstrap.
