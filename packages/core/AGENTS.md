# @stratasync/core

Core model runtime, schema metadata, sync primitives, and transaction system for the stratasync stack. Zero external dependencies, pure TypeScript.

## Commands

- `npm run build`: compile TypeScript (`tsc`)
- `npm run dev`: watch mode (`tsc --watch`)
- `npm run test`: run tests (Node built-in test runner with tsx)
- `npm run lint`: lint with Oxlint
- `npm run check-types`: type check without emitting

## Gotchas

- Zero dependencies. `mobx` is a peer dependency of sync-mobx, not sync-core; this package has no external deps.
- `ModelRegistry` is a global singleton populated at import time via decorators. Importing a model file registers it; in tests, call the `resetModelRegistry()` helper before each test to clear state.
- `setBoxFactory()` must be called before accessing observable model properties. Without it, the noop adapter is used and MobX reactivity won't work (sync-mobx handles this; sync-core itself never imports MobX).
- Delta application uses last-writer-wins conflict resolution at the field level, not document level. Concurrent writes to different fields merge cleanly, but same-field conflicts always take the server's value.
- Transaction serialization uses abbreviated field names (`cid`, `cli`, `m`, `mid`, `a`, `p`, `o`). Always use `serializeTransaction()`/`deserializeTransaction()`, never construct the compact format manually.
- Schema hash is deterministic and order-independent. Model registration order does not affect it, but adding, removing, or renaming fields changes the hash and triggers a client re-bootstrap.
- Tests use Node's built-in test runner (not Vitest). Run with `node --test --import tsx`; async test fixture methods may trigger Oxlint's `useAwait` lint rule (false positives for interface-matching stubs).

## Conventions

- Model decorators (`@ClientModel`, `@Property`, `@Reference`, `@OneToMany`) define the schema. Never manually construct schema metadata or call `ModelRegistry.registerModel()` directly.
- Use `LazyReference<T>` for ManyToOne relations, `LazyCollection<T>` for OneToMany. These hydrate lazily on first access via the `SyncStore`.
- Transaction creation helpers (`createInsertTransaction`, `createUpdateTransaction`, etc.) generate unique `clientTxId` values. Always use them instead of constructing `Transaction` objects manually.
- Property types are defined in `src/schema/types.ts`. New property types must be added there and handled in all consuming switch/if chains.
- `SyncStore` is the persistence interface that `Model.save()`/`.delete()`/`.archive()` delegate to. sync-core defines it, sync-client implements it.
