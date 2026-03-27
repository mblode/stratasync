# Model Patterns Reference

Guide for adding models beyond the initial scaffold and working with StrataSync's model system.

---

## Adding a new model (5-step checklist)

1. **Create client model**: `src/lib/sync/models/<model_name>.ts`

```ts
import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("<ModelName>", { loadStrategy: "instant" })
export class <ModelName> extends Model {
  @Property() declare id: string;
  // Add your fields here
  @Property() declare groupId: string;
}
```

2. **Add side-effect import**: `src/lib/sync/models.ts`

```ts
import "./models/todo";
import "./models/<model_name>"; // Add this line
```

This registers the decorators at module load. Without it, the model won't exist in the schema.

3. **Add Drizzle table**: `server/src/db/schema.ts`

```ts
export const <model_table> = pgTable("<model_table>", {
  groupId: text("group_id").notNull(),
  id: uuid("id").defaultRandom().primaryKey(),
  // Add your columns here
});
```

4. **Add SyncModelConfig**: `server/src/server.ts`

```ts
const <modelName>Config: SyncModelConfig = {
  bootstrap: {
    allowedIndexedKeys: ["id", "groupId"],
    buildScopeWhere: (filter, _db) =>
      filter.workspaceGroupIds.length > 0
        ? inArray(<model_table>.groupId, filter.workspaceGroupIds)
        : sql`false`,
    cursor: { idField: "id", type: "simple" },
    fields: ["id", /* your fields */, "groupId"],
    instantFields: [],
  },
  groupKey: "groupId",
  mutate: {
    actions: new Set(["I", "U", "D"]),
    insertFields: {
      // field: { type: "string" | "stringNull" | "number" | "date" | "dateNow" | "dateOnly" }
    },
    kind: "standard",
    updateFields: new Set([/* mutable field names */]),
  },
  table: <model_table>,
};

// Register in createSyncServer:
const sync = await createSyncServer({
  // ...
  models: {
    Todo: todoConfig,
    <ModelName>: <modelName>Config, // Add this
  },
  // ...
});
```

5. **Push schema**: `cd server && npm run db:push`

---

## Field types

| Client type              | Drizzle column                | Mutate type                       |
| ------------------------ | ----------------------------- | --------------------------------- |
| `string`                 | `text(...)`                   | `{ type: "string" }`              |
| `string \| null`         | `text(...)`                   | `{ type: "stringNull" }`          |
| `number`                 | `integer(...)` or `real(...)` | `{ type: "number" }`              |
| `boolean`                | `boolean(...)`                | `{ type: "string" }` (serialized) |
| `number` (timestamp)     | `timestamp(...)`              | `{ type: "date" }`                |
| `number` (server-set ts) | `timestamp(...)`              | `{ type: "dateNow" }`             |
| `number` (date-only)     | `date(...)`                   | `{ type: "dateOnly" }`            |
| `string` (uuid)          | `uuid(...)`                   | `{ type: "string" }`              |
| `string` (groupId)       | `text("group_id")`            | `{ type: "string" }`              |

- `"date"` — parses epoch ms sent by the client
- `"dateNow"` — ignores the client value; server sets current timestamp on insert/update
- `"stringNull"` — allows `null`; use for optional foreign keys and nullable text fields

---

## Load strategies

Set via the `@ClientModel` decorator's second argument:

| Strategy                | Behavior                                     | Use when                                           |
| ----------------------- | -------------------------------------------- | -------------------------------------------------- |
| `"instant"`             | Loaded immediately on sync start             | Small, frequently accessed data (todos, settings)  |
| `"lazy"`                | Loaded when first queried                    | Medium collections, not always needed              |
| `"partial"`             | Loaded on demand, partially hydrated         | Large models where only some fields are needed     |
| `"explicitlyRequested"` | Never auto-loaded, must be explicitly loaded | Large data, on-demand access                       |
| `"local"`               | Never synced, stored locally only            | Client-only state that should not reach the server |

```ts
@ClientModel("Todo", { loadStrategy: "instant" })
@ClientModel("Comment", { loadStrategy: "lazy" })
@ClientModel("Attachment", { loadStrategy: "explicitlyRequested" })
```

---

## Relations

### @Reference: belongs-to (foreign key on this model)

First argument is a **factory function** returning the related model class (not a string name). The foreign key defaults to `${propertyName}Id` and can be overridden via `options.foreignKey`. The optional second argument is the `inverseProperty` name on the related model (enables bidirectional linking with `@BackReference`).

```ts
import { ClientModel, Model, Property, Reference } from "@stratasync/core";

@ClientModel("Comment", { loadStrategy: "lazy" })
export class Comment extends Model {
  @Property() declare id: string;
  // todoId is the foreign key (inferred from property name "todo")
  // "comments" links bidirectionally to Todo.comments via @BackReference
  @Reference(() => Todo, "comments") declare todo: Todo;
  @Property() declare groupId: string;
}
```

### @BackReference: has-many (inverse of @Reference)

Takes an optional `options` object `{ foreignKey?: string }`. No model name argument — the model is inferred from the TypeScript type and the `inverseProperty` set on the corresponding `@Reference`.

```ts
import { BackReference, ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("Todo", { loadStrategy: "instant" })
export class Todo extends Model {
  @Property() declare id: string;
  @BackReference() declare comments: Comment[];
  @Property() declare groupId: string;
}
```

### @ReferenceArray: many-to-many via ID array

Takes an optional `options` object `{ through?: string }`. No model name or ID-field arguments — the model is inferred from the TypeScript type, and the ID array is a separate `@Property`.

```ts
import { ClientModel, Model, Property, ReferenceArray } from "@stratasync/core";

@ClientModel("Project", { loadStrategy: "instant" })
export class Project extends Model {
  @Property() declare id: string;
  @Property() declare memberIds: string[];
  @ReferenceArray() declare members: User[];
  @Property() declare groupId: string;
}
```

---

## Server config patterns

### groupKey options

```ts
// Simple: groupId is a direct column on the model table
groupKey: "groupId",

// Custom: if the group relationship is more complex
groupKey: {
  field: "workspaceId",
  resolve: (row) => row.workspaceId,
},
```

### Bootstrap allowedIndexedKeys

Fields listed in `allowedIndexedKeys` are the only fields the client may use as bootstrap filter keys. Include every field the client needs to filter by (IDs, foreign keys used in `useQuery` `where` clauses):

```ts
bootstrap: {
  allowedIndexedKeys: ["id", "groupId", "projectId"],
  // ...
},
```

Always include `"id"` plus any foreign key fields that appear in client-side queries.

### Bootstrap instantFields

Fields listed in `instantFields` are included in the initial sync payload for `"instant"` load strategy models. Use for sort/filter fields the client needs before full hydration:

```ts
bootstrap: {
  fields: ["id", "title", "completed", "createdAt", "groupId"],
  instantFields: ["createdAt"], // Included in instant load
  // ...
},
```

---

## Instance methods

Models have instance methods for mutations. Prefer these over `client.update()` / `client.delete()` for cleaner code.

### .save() — update via property assignment

```ts
// Set properties directly, then persist
item.title = "Updated title";
item.completed = true;
await item.save();
```

This is the idiomatic update pattern. Change tracking records original values automatically so the sync engine can compute deltas.

### .delete() — delete from instance

```ts
await item.delete();
```

### .archive() / .unarchive() — soft delete

```ts
await item.archive();
await item.unarchive();
```

---

## Common patterns

### Soft delete (archive)

Use the `"A"` (archive) and `"V"` (unarchive) actions instead of treating archive as a regular update:

```ts
// Client model
@Property() declare archivedAt: number | null;

// Drizzle column
archivedAt: timestamp("archived_at", { withTimezone: true }),

// Server config: include A and V actions
actions: new Set(["I", "U", "D", "A", "V"]),
updateFields: new Set(["title", "completed", "archivedAt"]),

// Mutations via instance methods
await item.archive();
await item.unarchive();

// Query non-archived items
const { data } = useQuery<Todo>("Todo", {
  where: (item) => item.archivedAt === null,
});
```

### Timestamps

```ts
// Client model
@Property() declare createdAt: number;
@Property() declare updatedAt: number;

// Drizzle columns
createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

// Server config
insertFields: {
  createdAt: { type: "date" },
  updatedAt: { type: "date" },
},
updateFields: new Set(["updatedAt", /* other mutable fields */]),
```

### Ordering queries

```ts
// Newest first
const { data } = useQuery<Todo>("Todo", {
  orderBy: (a, b) => b.createdAt - a.createdAt,
});

// Alphabetical
const { data } = useQuery<Todo>("Todo", {
  orderBy: (a, b) => a.title.localeCompare(b.title),
});
```

### Date-only fields

Date-only fields (e.g. `dueDate`, `startDate`) use day-aligned UTC epochs, not instant timestamps. You **must** declare them in `dateOnlyFields` or values will be corrupted:

```ts
// Client model
@Property() declare dueDate: number | null;

// Drizzle column
dueDate: date("due_date"),

// Server config — dateOnlyFields is CRITICAL
bootstrap: {
  fields: ["id", "title", "dueDate", "groupId"],
  dateOnlyFields: ["dueDate"],
  instantFields: ["createdAt"],
  // ...
},
mutate: {
  insertFields: {
    dueDate: { type: "dateOnly" },
  },
  updateFields: new Set(["title", "dueDate"]),
  // ...
},
```

---

## Mutation hooks

Server-side hooks run before and after mutations for validation, authorization, and side effects:

```ts
const taskConfig: SyncModelConfig = {
  // ...
  mutate: {
    kind: "standard",
    actions: new Set(["I", "U", "D", "A", "V"]),
    insertFields: {
      /* ... */
    },
    updateFields: new Set(["title", "completed"]),

    // Validate or transform data before insert
    onBeforeInsert: async (db, modelId, payload, data, context) => {
      if (!context) throw new Error("Authentication required");
      // Return modified data to insert
      return { ...data, createdBy: context.userId };
    },

    // Validate before update
    onBeforeUpdate: async (db, modelId, payload, data, context) => {
      if (!context) throw new Error("Authentication required");
      return data;
    },

    // Validate before delete
    onBeforeDelete: async (db, modelId, payload, context) => {
      if (!context) throw new Error("Authentication required");
    },

    // Side effects after any mutation
    onAfterMutation: async (ctx) => {
      // ctx.action, ctx.modelId, ctx.data, ctx.db
    },
  },
  // ...
};
```

---

## Composite models (many-to-many)

For join tables (e.g. TaskLabel, TeamMembership), use composite models with synthetic UUIDv5 IDs:

```ts
import { v5 as uuidv5 } from "uuid";

const NAMESPACE = "92a73695-d772-4b43-9fb4-d79f5fbef300";

const computeId = (workspaceId: string, taskId: string, labelId: string) =>
  uuidv5(`TaskLabel:[${workspaceId},${taskId},${labelId}]`, NAMESPACE);

const taskLabelConfig: SyncModelConfig = {
  table: taskLabels,
  bootstrap: {
    fields: ["id", "taskId", "labelId", "groupId"],
    cursor: { idField: "id", type: "simple" },
    buildScopeWhere: (filter) =>
      filter.workspaceGroupIds.length > 0
        ? inArray(taskLabels.groupId, filter.workspaceGroupIds)
        : sql`false`,
  },
  groupKey: "groupId",
  mutate: {
    kind: "composite",
    actions: new Set(["I", "D"]),
    insertFields: {
      taskId: { type: "string" },
      labelId: { type: "string" },
      groupId: { type: "string" },
    },
    computeId: (_modelId, data) =>
      computeId(data.groupId, data.taskId, data.labelId),
  },
};
```

Composite models typically only support insert and delete (no update). The same inputs always produce the same ID (deterministic).
