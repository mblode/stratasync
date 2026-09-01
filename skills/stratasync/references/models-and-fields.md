# Models and fields

Every layer filters explicitly. A field registered in one place and not the
others is dropped with no error, so treat a field as a four-part change.

## Client model

```ts
import { ClientModel, Model, Property, Reference } from "@stratasync/core";

@ClientModel("Task", { loadStrategy: "instant" })
export class Task extends Model {
  @Property() declare id: string;
  @Property() declare title: string;
  @Property() declare completed: boolean;
  @Property() declare createdAt: number;
  @Property() declare groupId: string;
}
```

`declare` matters: it tells TypeScript not to emit an initialiser, which would
overwrite the accessor the decorator installs. Without it the property reads
`undefined` at runtime.

`id` is optional. The registry adds the primary key to the field set if you do
not declare it, so declaring it is a style choice rather than a requirement.

### Load strategies

| Strategy              | When it loads                                                 |
| --------------------- | ------------------------------------------------------------- |
| `instant`             | In the initial bootstrap. For small sets read on every screen |
| `lazy`                | On first access, then cached locally                          |
| `partial`             | By index value, e.g. every comment for one task               |
| `explicitlyRequested` | Only when you ask for it by hand                              |
| `local`               | Never syncs. Client-only state                                |

`instant` is the default and the right answer until a model is large enough to
slow the first load.

### Registration happens at import time

Decorators run when the module is imported, so a model file that nothing
imports registers nothing. Keep a barrel that imports every model for its side
effects, and import that barrel before creating the client:

```ts
// lib/sync/models.ts
import "./models/task";
import "./models/project";
```

## Relations

```ts
// Child holds the foreign key. First argument is a factory, not a name string.
@Reference(() => Project, "tasks") declare project: Project;

// Parent side, a lazy collection.
@OneToMany() declare tasks: LazyCollection<Task>;

// Inverse without its own storage.
@BackReference() declare comments: Comment[];

// Many-to-many through a join model.
@ReferenceArray({ through: "TaskTag" }) declare tags: Tag[];
```

`@Reference` creates the foreign key (`project` becomes `projectId`, override
with `options.foreignKey`). The optional second argument names the inverse
property so the two sides link up.

## Server side

The server holds the same model twice: as a Drizzle table, and as a sync model
config. Both have to change.

```ts
// The config decides what the sync layer will accept.
Task: {
  kind: "standard",
  table: tasks,
  fields: { /* everything readable */ },
  updateFields: new Set(["title", "completed", "updatedAt"]),
}
```

**`updateFields` is the one that bites.** An update payload is filtered through
it and anything absent is dropped silently: the write succeeds, the response is
fine, and the value is simply not there after a reload. If a field writes
locally and disappears on refresh, check this set first.

Composite models (join tables keyed by two columns rather than an `id`) use
`kind: "composite"` and support insert and delete only, not update.

## Date encodings

Date-only fields and instants use different epoch encodings. Mixing them
corrupts data in a way that survives sync, because both are just numbers on the
wire. Confirm which a field is before adding it.

## The schema hash

`computeSchemaHash()` covers every model and property. Adding, removing or
renaming a field changes it, and a changed hash forces every client through one
full re-bootstrap. That is correct and self-healing, but it is a real cost on a
large dataset, so batch schema changes rather than shipping them one at a time.
