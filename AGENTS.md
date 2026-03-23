# stratasync

Local-first, server-sequenced sync engine for TypeScript, React, and Next.js

## Commands

```bash
npm install              # setup (requires Node >= 22)
npm run build            # turbo run build
npm run dev              # turbo run dev
npm run test             # turbo run test
npm run typecheck        # tsc --noEmit
npm run lint:fix          # oxfmt + oxlint autofix
npm run lint              # oxfmt check + oxlint (CI)
```

## Architecture

```
packages/
  core/               # Model runtime, schema, decorators, transactions
  y-doc/              # Yjs CRDT for collaborative editing
  client/             # Client orchestrator, outbox, queries, events
  react/              # React hooks and provider
  mobx/               # MobX reactivity adapter
  next/               # Next.js App Router integration
  storage-idb/        # IndexedDB storage adapter
  transport-graphql/  # GraphQL + WebSocket transport
  server/             # Server-side sync with Fastify + Drizzle
apps/
  docs/               # Fumadocs documentation site
```

## Build Order

```
Layer 0: core, server (no internal deps)
Layer 1: y-doc, mobx (depend on core)
Layer 2: client (depends on core, y-doc)
Layer 3: react, storage-idb, transport-graphql (depend on client + core)
Layer 4: next (depends on client, core, react)
```

## Gotchas

- **ESM only**: This project uses `"type": "module"`. Use `.js` extensions in imports (e.g., `import { foo } from "./foo.js"`).
- **Linting via oxlint/oxfmt**: Run `npm run lint:fix` to format and fix. Config presets come from `ultracite` (in `.oxlintrc.json` extends).
- **Git hooks via lefthook**: Pre-commit runs oxfmt + oxlint on staged files. Hooks install automatically via `npm install`.
- **Internal deps use workspace protocol**: All `@stratasync/*` inter-package dependencies use `"workspace:*"`.
