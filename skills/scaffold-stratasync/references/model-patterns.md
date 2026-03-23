# Model Patterns Reference

Guide for adding models beyond the initial scaffold and working with Strata Sync's model system.

---

## Adding a new model (5-step checklist)

1. **Create client model** — `src/lib/sync/models/<model_name>.ts`

```ts
import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("<ModelName>", { loadStrategy: "instant" })
export class <ModelName> extends Model {
  @Property() declare id: string;
  // Add your fields here
  @Property() declare groupId: string;
}
```

2. **Add side-effect import** — `src/lib/sync/models.ts`

```ts
import "./models/todo";
import "./models/<model_name>"; // Add this line
```

This registers the decorators at module load. Without it, the model won't exist in the schema.

3. **Add Drizzle table** — `server/src/db/schema.ts`

```ts
export const <model_table> = pgTable("<model_table>", {
  groupId: text("group_id").notNull(),
  id: uuid("id").defaultRandom().primaryKey(),
  // Add your columns here
});
```

4. **Add SyncModelConfig** — `server/src/server.ts`

```ts
const <modelName>Config: SyncModelConfig = {
  bootstrap: {
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
      // field: { type: "string" | "date" | "number" | "boolean" }
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

5. **Push schema** — `cd server && npm run db:push`

---

## Field types

| Client type          | Drizzle column                | Mutate type                       |
| -------------------- | ----------------------------- | --------------------------------- |
| `string`             | `text(...)`                   | `{ type: "string" }`              |
| `number`             | `integer(...)` or `real(...)` | `{ type: "number" }`              |
| `boolean`            | `boolean(...)`                | `{ type: "string" }` (serialized) |
| `number` (timestamp) | `timestamp(...)`              | `{ type: "date" }`                |
| `string` (uuid)      | `uuid(...)`                   | `{ type: "string" }`              |
| `string` (groupId)   | `text("group_id")`            | `{ type: "string" }`              |

---

## Load strategies

Set via the `@ClientModel` decorator's second argument:

| Strategy     | Behavior                              | Use when                                          |
| ------------ | ------------------------------------- | ------------------------------------------------- |
| `"instant"`  | Loaded immediately on sync start      | Small, frequently accessed data (todos, settings) |
| `"lazy"`     | Loaded when first queried             | Medium collections, not always needed             |
| `"explicit"` | Only loaded when explicitly requested | Large data, on-demand access                      |

```ts
@ClientModel("Todo", { loadStrategy: "instant" })
@ClientModel("Comment", { loadStrategy: "lazy" })
@ClientModel("Attachment", { loadStrategy: "explicit" })
```

---

## Relations

### @Reference — belongs-to (foreign key on this model)

```ts
import { ClientModel, Model, Property, Reference } from "@stratasync/core";

@ClientModel("Comment", { loadStrategy: "lazy" })
export class Comment extends Model {
  @Property() declare id: string;
  @Property() declare todoId: string;
  @Reference("Todo", "todoId") declare todo: Todo;
  @Property() declare groupId: string;
}
```

### @BackReference — has-many (inverse of @Reference)

```ts
import { BackReference, ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("Todo", { loadStrategy: "instant" })
export class Todo extends Model {
  @Property() declare id: string;
  @BackReference("Comment", "todoId") declare comments: Comment[];
  @Property() declare groupId: string;
}
```

### @ReferenceArray — many-to-many via ID array

```ts
import { ClientModel, Model, Property, ReferenceArray } from "@stratasync/core";

@ClientModel("Project", { loadStrategy: "instant" })
export class Project extends Model {
  @Property() declare id: string;
  @Property() declare memberIds: string[];
  @ReferenceArray("User", "memberIds") declare members: User[];
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

## Common patterns

### Soft delete (archive)

```ts
// Client model
@Property() declare archivedAt: number | null;

// Drizzle column
archivedAt: timestamp("archived_at", { withTimezone: true }),

// Server config — add to updateFields
updateFields: new Set(["title", "completed", "archivedAt"]),

// Query non-archived items
const { data } = useQuery<Todo>("Todo", {
  filter: (item) => item.archivedAt === null,
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
