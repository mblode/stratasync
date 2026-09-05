# @stratasync/server

Server-side sync SDK. Provides bootstrap streaming, delta publishing, mutation processing, and WebSocket real-time sync with a registration-based model API.

## Quick Start

```typescript
import { createSyncServer } from "@stratasync/server";
import { syncActions, syncGroupMemberships, tasks, labels } from "./schema";

const sync = await createSyncServer({
  db,
  tables: { syncActions, syncGroupMemberships },
  auth: {
    verifyToken: async (token) => {
      const user = await verifyJwt(token);
      return user ? { userId: user.id, email: user.email } : null;
    },
    resolveGroups: async (userId) => {
      // Return workspace IDs the user belongs to
      return ["workspace-1", userId];
    },
  },
  models: {
    Task: {
      table: tasks,
      groupKey: "workspaceId",
      bootstrap: {
        fields: ["id", "title", "completedAt", "workspaceId", "createdAt"],
        instantFields: ["completedAt", "createdAt"],
        cursor: { type: "simple", idField: "id" },
        buildScopeWhere: (filter) =>
          inArray(getColumn(tasks, "workspaceId"), filter.workspaceGroupIds),
      },
      mutate: {
        kind: "standard",
        actions: new Set(["I", "U", "D"]),
        insertFields: {
          title: { type: "string" },
          completedAt: { type: "date" },
          workspaceId: { type: "string" },
          createdAt: { type: "dateNow" },
        },
        updateFields: new Set(["title", "completedAt"]),
      },
    },
  },
});

// Register on Fastify
sync.registerRoutes(fastifyServer);
```

## Architecture

```
Client                          Server (@stratasync/server)
  |                                |
  |-- GET /sync/bootstrap -------->| BootstrapService
  |<-------- NDJSON stream --------|   Streams all model rows with cursor pagination
  |                                |
  |-- POST /sync/mutate ---------> | MutateService
  |<-------- { lastSyncId } -------|   Validates, deduplicates, writes sync_actions
  |                                |
  |-- GET /sync/deltas ----------> | DeltaService
  |<-------- { actions[] } --------|   Fetches sync_actions after cursor
  |                                |
  |-- WS /sync/ws ---------------> | WebSocket handler
  |<====== real-time deltas =======|   Subscribe, replay, buffer, flush
  |                                |
                                   | DeltaPublisher
                                   |   Redis pub/sub + in-memory fallback
```

### Sync Protocol

1. **Bootstrap**: Client sends `GET /sync/bootstrap`. Server streams all model rows as NDJSON (first line = metadata with `lastSyncId`, subsequent lines = model rows with `__class` tag).

2. **Mutations**: Client sends `POST /sync/mutate` with a batch of transactions. Each transaction specifies `modelName`, `modelId`, `action` (INSERT/UPDATE/DELETE/ARCHIVE/UNARCHIVE), and `payload`. Server deduplicates via `(clientId, clientTxId)` unique constraint, applies the mutation, creates a `sync_action` row, and publishes a delta.

3. **Deltas**: Client polls `GET /sync/deltas?after={lastSyncId}` for incremental updates. Returns actions with `hasMore` flag for pagination.

4. **WebSocket**: Client connects to `/sync/ws` and sends a `subscribe` message with `afterSyncId`. Server replays missed actions, then streams live deltas. Buffers actions during replay to prevent gaps.

### Key Concepts

**Sync Groups**: Every model declares a `groupKey` (e.g., `"workspaceId"`) that determines which sync group it belongs to. Users can only see models in their groups. The special value `"__modelId__"` means the model's own ID is its group (used for User/Workspace models). `null` means globally visible. For a group that depends on the row rather than on one static column, use `resolveGroup` (see [Per-row group scoping](#per-row-group-scoping)).

**Field Codecs**: Field types (`string`, `stringNull`, `number`, `date`, `dateNow`, `dateOnly`) control how payload values are coerced on insert/update and serialized for sync. `dateOnly` fields use day-aligned UTC epochs (multiples of 86400000ms). `date`/`dateNow` fields use millisecond epochs.

**Cursor Pagination**: Bootstrap uses cursor-based pagination. Simple cursors use `id > cursor`. Composite cursors (for join tables like TaskLabel) use multi-level OR conditions.

**Deduplication**: Mutations include `clientId` + `clientTxId`. A unique constraint on `sync_actions(client_id, client_tx_id)` prevents duplicate processing. If a duplicate is detected, the existing `syncId` is returned.

## Model Config

Each model needs both `bootstrap` (how to stream it) and `mutate` (how to process mutations) config:

```typescript
interface SyncModelConfig {
  table: AnyPgTable; // Drizzle table reference
  groupKey: string | "__modelId__" | null; // Sync group field
  resolveGroup?: (
    ctx: ResolveGroupContext
  ) => string | null | Promise<string | null>;
  groupType?: string; // Type recorded on memberships this model creates
  insertCreatesGroup?: boolean; // Let an insert open its own group
  bootstrap: BootstrapModelConfig;
  mutate: StandardMutateConfig | CompositeMutateConfig;
}
```

### Per-row group scoping

`groupKey` names a single static column, so a row's audience cannot depend on
the row. `groupKey` is sugar: it is compiled into a `resolveGroup` at registry time, so
there is one resolver per model rather than two branches to keep in step. Supply
`resolveGroup` directly when the group depends on the row. It receives the
action, the payload, the existing row (for non-inserts), and the caller's
context:

```typescript
Project: {
  groupKey: null,
  groupType: "project",
  insertCreatesGroup: true,
  resolveGroup: ({ modelId }) => modelId, // a project is its own group
  ...
},

Task: {
  groupKey: null,
  resolveGroup: async ({ context, payload, record }) =>
    (payload.projectId ?? record?.projectId ?? context.userId) as string | null,
  ...
},
```

Returning `null` means ungrouped, exactly as `groupKey: null` does.

`insertCreatesGroup` exists because group resolution runs _before_ the model
mutation: a model whose group is its own id would otherwise be uninsertable,
since the group does not exist yet and the creator is not a member. With the
flag set, an INSERT whose resolved group is absent from `context.groups` writes
the membership row **in the same transaction** and proceeds. Every other action
is unchanged — you still cannot write to a group you do not belong to.

> **Only set `insertCreatesGroup` on a model whose resolved group is unforgeable
> by the caller** — in practice, the row's own id. On a model that resolves to
> some _other_ row's group (a task resolving to its project, say) the flag would
> hand a non-member membership of that group simply by inserting into it.

### Group membership notifications

Deltas are cursor-based, so a user newly added to a group has no prior actions
for it and its history sits _before_ their cursor: sharing would deliver
nothing. Leaving is worse — the rows stop updating and linger in the local
cache.

```typescript
await server.notifyGroupsChanged(userId); // after writing/revoking membership
```

This writes a `"G"` sync action addressed to the user's own group, carrying
their full current group list (recomputed from the same sources
`authorizeToken` uses), and publishes it. Because it is an ordinary sync action
it carries a syncId and lives in `sync_actions`, so it is delivered by the live
stream, replay, catch-up and bootstrap alike — **a user who is offline when
their membership changes still receives it.** An out-of-band frame would be
dropped, leaving that client's cache serving rows from a group it no longer
belongs to.

It emits the action only; writing or revoking the membership row stays the
caller's job (`syncDao.addGroupMembership` / `removeGroupMembership`).

The client side is already handled by `@stratasync/client`: `SyncGroupManager`
partial-bootstraps added groups and drops removed ones. A client that does not
understand `"G"` actions ignores them (the row-applying path skips actions whose
model is not in its registry) and converges on its next bootstrap. The server
still shrinks an active WebSocket subscription before delivering later actions,
so ignoring the refresh cannot retain access to a removed group. Refreshes never
add groups to a connection; additions require another authorized subscribe.

## Auth

Auth is pluggable. Existing user-only authentication needs two callbacks:

```typescript
auth: {
  verifyToken: async (token: string) => SyncAuthPayload | null,
  resolveGroups: async (userId: string) => string[],
}
```

For credentials with narrower authority than their user, preserve an opaque
principal and authorize the operation plus its final groups in one callback:

```typescript
auth: {
  verifyToken: async (token) => ({
    userId: key.userId,
    principal: { kind: "apiKey", scopes: key.scopes, groupIds: key.groupIds },
  }),
  resolveGroups,
  authorizeAccess: async ({ groups, operation, principal }) => {
    if (!canUseOperation(principal, operation)) return false;
    return { allowedGroups: groups.filter((group) => canUseGroup(principal, group)) };
  },
}
```

The policy runs for every HTTP request and WebSocket subscribe. It may only
narrow resolved groups; unknown groups in `allowedGroups` are discarded, and
the personal user group is retained only when the policy returns it. A
verified payload that carries `principal` fails closed when `authorizeAccess`
is missing. The opaque principal and final group set are available to mutation,
group-resolution, and WebSocket hooks. Durable group-refresh actions are also
intersected with the connection's existing groups before delivery. This removes
revoked groups immediately and cannot widen a restricted credential.

The package does not know about JWT, API keys, or any auth provider. Your app provides the verification and policy logic.

WebSocket upgrades prefer the standard `Authorization: Bearer ...` credential
and retain `?token=` as a legacy fallback. Conflicting header and query tokens
are rejected. The selected upgrade credential cannot be overridden by a token
inside a subscribe frame: its authorized context is cached for the first
subscribe, then the same credential is verified and authorized again on every
resubscribe. This also rechecks credential expiry and current group policy.

## WebSocket Hooks

Inject app-specific WebSocket behavior (e.g., live editing) via hooks:

```typescript
websocketHooks: {
  onMessage: async (ws, message, context) => boolean,  // return true if handled
  onClose: async (ws, context) => void,
  onSubscribe: async (ws, context, previousContext) => void,
}
```

## Database Requirements

The package requires two Drizzle tables passed via `config.tables`:

**`syncActions`**: Columns are `id` (bigserial PK), `model` (varchar), `modelId` (uuid), `action` (char 1), `data` (jsonb), `groupId` (uuid nullable), `clientId` (varchar nullable), `clientTxId` (uuid nullable), `createdAt` (timestamp). Unique constraint on `(clientId, clientTxId)`.

**`syncGroupMemberships`**: Columns are `id` (uuid PK), `userId` (uuid), `groupId` (uuid), `groupType` (varchar), `createdAt` (timestamp).

## Exports

```typescript
// Main entry: import from "@stratasync/server"
import { createSyncServer, SyncDao, BootstrapService, ... } from "@stratasync/server";

// Fastify-specific: import from "@stratasync/server/fastify"
import { registerSyncRoutes, createSyncAuthMiddleware, ... } from "@stratasync/server/fastify";
```

`createBootstrapRouteHandler(sync.bootstrapService)` and
`createBatchLoadRouteHandler(sync.bootstrapService)` expose the same native
Fastify streams when an app registers those routes itself. They return Node
streams through `reply.send`, preserving Fastify lifecycle hooks and stream
backpressure.

## Error Handling

- **Pub/sub callback errors** are caught and silently ignored (standard event emitter pattern). Delta delivery is best-effort.
- **Mutation hook errors** (`onAfterMutation`) are logged as warnings but do not fail the transaction. The sync action is already committed.
- **Authentication failures** return 401. Access-policy denials return 403;
  policy execution failures return 500.
- **Validation failures** return 400 with field-level error details.
