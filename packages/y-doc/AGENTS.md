# @stratasync/y-doc

Yjs CRDT utilities and integration for collaborative editing.

## Commands

- `npm run build`: compile TypeScript (`tsc -p tsconfig.build.json`)
- `npm run dev`: watch mode (`tsc --watch -p tsconfig.build.json`)
- `npm run test`: run tests (`vitest run`)
- `npm run check-types`: type check package sources and tests without emitting

## Gotchas

- Uses `tsconfig.build.json` for builds (not the default `tsconfig.json`).
- `yjs` is a peer dependency. Install it alongside `@stratasync/y-doc`.
- Awareness (presence) protocol requires a separate connection channel. It does not go through the sync delta pipeline.
- Yjs documents are binary-encoded. Always use `Y.encodeStateAsUpdate` / `Y.applyUpdate`, not JSON serialization.

## Conventions

- Yjs documents map to entity fields (e.g., Task.description), one Yjs doc per collaborative field.
- Use the awareness protocol for presence/cursor tracking.
- Delta serialization must be compatible with sync-transport-graphql's encoding.
