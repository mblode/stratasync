# @stratasync/storage-idb

IndexedDB storage adapter for client-side persistence.

## Commands

- `npm run build` — compile TypeScript (`tsc`)
- `npm run dev` — watch mode (`tsc --watch`)
- `npm run test` — run tests (`node --import tsx --test "tests/**/*.test.ts"`)
- `npm run lint` — lint with Oxlint
- `npm run check-types` — type check without emitting

## Gotchas

- Tests use `fake-indexeddb` — this is a devDependency for mocking IndexedDB in Node. Tests will fail without it.
- Uses Node's built-in test runner (not Vitest) — test files follow `tests/**/*.test.ts` pattern
- The `idb` library (^8.0.0) wraps the raw IndexedDB API — use its transaction API, not raw IDB transactions
- Schema migrations run on database open — always increment the version number when changing the schema

## Conventions

- All reads/writes go through the `idb` wrapper — never use raw `indexedDB` API
- Storage operations are transactional — group related writes in a single transaction
- Offline persistence is the primary use case — design for eventually-consistent data
