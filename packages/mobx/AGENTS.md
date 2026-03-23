# @stratasync/mobx

MobX reactivity adapter and model utilities for the sync system.

## Commands

- `npm run build`: compile TypeScript (`tsc`)
- `npm run dev`: watch mode (`tsc --watch`)
- `npm run test`: run tests (`vitest`)
- `npm run lint`: lint with Oxlint
- `npm run check-types`: type check without emitting

## Modules

| Module                  | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `adapter.ts`            | `ReactivityAdapter` implementation using MobX (boxes, maps, arrays, reactions, computed) |
| `dirty-tracking.ts`     | MobX-observable dirty tracker for model instances (`isDirty`, `modifiedFields`)          |
| `observable-model.ts`   | `makeModelObservable()` enhancement that attaches a DirtyTracker to a Model              |
| `model-utils.ts`        | `toPlainObject`, `cloneModelData`, `diffModels`, `isModelDirty`                          |
| `computed-relations.ts` | `computedReference`, `computedCollection`: MobX computed helpers for FK resolution       |

## Gotchas

- `mobx` ^6.0.0 is a peer dependency. The consuming app must install it.
- This package implements the reactivity adapter interface defined in `@stratasync/core`. Changes to the interface require updates here.
- MobX observable properties are set up during model hydration. Accessing properties before hydration will not trigger reactions.
- `createMobXReactivity()` calls `initMobXObservability()` which registers a MobX box factory with sync-core. This must happen before any model property is accessed.
- `_applyUpdate()` on Model suppresses change tracking. The dirty tracker correctly ignores server-side updates via the `suppressTracking` counter.
- `computedCollection` requires the store to expose a `getAll(modelName)` method, which is not part of the base `SyncStore` interface.

## Conventions

- Implement the `ReactivityAdapter` interface from sync-core. Do not create a custom interface.
- Use MobX `makeObservable` / `makeAutoObservable` patterns, not legacy decorators.
- Computed values should derive from observable model properties only.
- Use `toPlainObject()` instead of spread when you need a plain copy of a model (MobX prototype getters are not copied by spread).
- Use `createDirtyTracker()` or `makeModelObservable()` when you need reactive dirty state. Do not manually track changes.
