# @stratasync/react

React bindings and hooks for the sync system.

## Commands

- `npm run build` — compile TypeScript (`tsc`)
- `npm run dev` — watch mode (`tsc --watch`)
- `npm run test` — run tests (`vitest`, uses jsdom + React Testing Library)
- `npm run lint` — lint with Oxlint
- `npm run check-types` — type check without emitting

## Gotchas

- React 18 and 19 are both supported as peer dependencies — test against both if changing hook signatures
- `useModel` uses Suspense (throws a promise) — wrap consumers in `<Suspense>` boundaries
- `useQuery` returns `{ data, isLoading }` without Suspense — use this when you need loading states
- Yjs hooks (`useYjsDocument`, `useYjsPresence`) require `yjs` as a peer dependency

## Conventions

- Hook naming: `useModel` (Suspense), `useModelState` (non-Suspense with loading state)
- All hooks must be called at the top level — never conditionally
- SyncProvider must wrap the component tree before any sync hooks are used
- Prefer foreign-key helper hooks (`useTagsByWorkspace`) over filtering all records client-side
