# @stratasync/yjs

Yjs CRDT utilities and integration for collaborative editing.

## Commands

- `npm run build` — compile TypeScript (`tsc -p tsconfig.build.json`)
- `npm run dev` — watch mode (`tsc --watch -p tsconfig.build.json`)
- `npm run test` — run tests (`vitest run`)
- `npm run lint` — lint with Oxlint
- `npm run check-types` — type check without emitting

## Gotchas

- Uses `tsconfig.build.json` for builds (not the default `tsconfig.json`)
- `yjs` ^13.6.21 is a direct dependency — keep in sync with the version used by sync-react and sync-transport-graphql
- Awareness (presence) protocol requires a separate connection channel — it does not go through the sync delta pipeline
- Yjs documents are binary-encoded — always use `Y.encodeStateAsUpdate` / `Y.applyUpdate`, not JSON serialization

## Conventions

- Yjs documents map to entity fields (e.g., Task.description) — one Yjs doc per collaborative field
- Use the awareness protocol for presence/cursor tracking
- Delta serialization must be compatible with sync-transport-graphql's encoding
