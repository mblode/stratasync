# @stratasync/core

Core model runtime, schema metadata, sync primitives, and transaction system for the stratasync stack.

## Overview

sync-core provides the foundation for the stratasync stack:

- **Model system** with decorator-based schema definitions
- **Delta application** with last-writer-wins conflict resolution (field-level)
- **Transaction creation and serialization** for client-server sync
- **Archive/unarchive** soft-delete support
- **Reactivity adapter** abstraction (implemented by sync-mobx)
- **Schema registry** with deterministic hashing for bootstrap validation
- **Identity map** and change tracking

Zero external dependencies. Pure TypeScript.

## Installation

```bash
npm install @stratasync/core
```

## Model Definitions

Models use TypeScript decorators for schema metadata:

```typescript
import { ClientModel, Property, ManyToOne, OneToMany } from "@stratasync/core";

@ClientModel("Task", {
  loadStrategy: "instant",
  tableName: "task",
  groupKey: "teamId",
})
class Task {
  @Property({ type: "string" })
  title: string;

  @Property({ type: "number" })
  createdAt: number;

  @ManyToOne("Team", { fk: "teamId" })
  team: LazyReference<Team>;

  @OneToMany("TaskChecklistItem", { fk: "taskId" })
  checklistItems: LazyCollection<TaskChecklistItem>;
}
```

## Schema System

The schema registry normalizes decorator metadata into a queryable format:

- `@ClientModel`: Registers the model class with load strategy and table mapping
- `@Property`: Defines a field with its type (`string`, `number`, `boolean`, `json`)
- `@ManyToOne` / `@Reference`: Defines a foreign key relation with lazy loading
- `@OneToMany` / `@ReferenceCollection`: Defines a reverse relation as a lazy collection
- `@BackReference`: Back-reference without storage
- `@ReferenceArray`: Many-to-many via through model
- `@EphemeralProperty`: Non-persisted property

## Sync Primitives

- **Delta applier**: Applies server deltas to local model instances using last-writer-wins
- **Rebase logic**: Reconciles local optimistic changes with server-confirmed state
- **Transaction helpers**: `createInsertTransaction`, `createUpdateTransaction`, `createDeleteTransaction`, `createArchiveTransaction`, `createUnarchiveTransaction`, `createUndoTransaction`
- **Serialization**: Compact format with abbreviated field names for storage and transport
- **Schema hash**: Deterministic, order-independent hash for detecting schema changes

## Package Structure

```
src/
├── model/       Model base class, hydration, cached promises, collections
├── schema/      Decorators, type definitions, normalization, registry, hashing
├── transaction/ Creation helpers, serialization, archive utilities, types
├── sync/        Delta applier, rebase logic, sync IDs, sync types
├── store/       SyncStore interface (implemented by sync-client)
├── reactivity/  ReactivityAdapter interface (implemented by sync-mobx)
└── utils/       ID generation, assignment helpers
```
