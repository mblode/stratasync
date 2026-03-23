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

**Sync Groups**: Every model declares a `groupKey` (e.g., `"workspaceId"`) that determines which sync group it belongs to. Users can only see models in their groups. The special value `"__modelId__"` means the model's own ID is its group (used for User/Workspace models). `null` means globally visible.

**Field Codecs**: Field types (`string`, `stringNull`, `number`, `date`, `dateNow`, `dateOnly`) control how payload values are coerced on insert/update and serialized for sync. `dateOnly` fields use day-aligned UTC epochs (multiples of 86400000ms). `date`/`dateNow` fields use millisecond epochs.

**Cursor Pagination**: Bootstrap uses cursor-based pagination. Simple cursors use `id > cursor`. Composite cursors (for join tables like TaskLabel) use multi-level OR conditions.

**Deduplication**: Mutations include `clientId` + `clientTxId`. A unique constraint on `sync_actions(client_id, client_tx_id)` prevents duplicate processing. If a duplicate is detected, the existing `syncId` is returned.

## Model Config

Each model needs both `bootstrap` (how to stream it) and `mutate` (how to process mutations) config:

```typescript
interface SyncModelConfig {
  table: AnyPgTable; // Drizzle table reference
  groupKey: string | "__modelId__" | null; // Sync group field
  bootstrap: BootstrapModelConfig;
  mutate: StandardMutateConfig | CompositeMutateConfig;
}
```

### Standard Models

Most models use `StandardMutateConfig` with an `id` primary key:

```typescript
mutate: {
  kind: "standard",
  actions: new Set(["I", "U", "D", "A", "V"]),
  insertFields: { title: { type: "string" }, ... },
  updateFields: new Set(["title", "completedAt"]),
  onBeforeInsert: async (db, modelId, payload, data) => data,
  onBeforeUpdate: async (db, modelId, payload, data) => data,
  onAfterMutation: (ctx) => { /* side effects */ },
}
```

### Composite Models

Join tables (e.g., TaskLabel) use `CompositeMutateConfig` with no `id` field:

```typescript
mutate: {
  kind: "composite",
  actions: new Set(["I", "D"]),
  insertFields: { taskId: { type: "string" }, labelId: { type: "string" } },
  buildDeleteWhere: (payload) => and(eq(table.taskId, payload.taskId), ...),
  compositeId: {
    computeId: (modelName, modelId, payload) => uuidv5(...),
  },
}
```

## Auth

Auth is pluggable via two callbacks:

```typescript
auth: {
  verifyToken: async (token: string) => SyncAuthPayload | null,
  resolveGroups: async (userId: string) => string[],
}
```

The package does not know about JWT, API keys, or any auth provider. Your app provides the verification logic.

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

## Error Handling

- **Pub/sub callback errors** are caught and silently ignored (standard event emitter pattern). Delta delivery is best-effort.
- **Mutation hook errors** (`onAfterMutation`) are logged as warnings but do not fail the transaction. The sync action is already committed.
- **Auth failures** return 401 with descriptive error messages.
- **Validation failures** return 400 with field-level error details.
