# stratasync

Local-first, server-sequenced sync engine for TypeScript, React, and Next.js

## Commands

```bash
npm install              # setup (requires Node >= 22)
npm run build            # turbo run build
npm run dev              # turbo run dev
npm run test             # turbo run test
npm run typecheck        # turbo run check-types
npm run lint:fix         # oxfmt + oxlint autofix (repo-wide)
npm run lint             # oxfmt check + oxlint (CI; repo-wide)
```

Lint and format are **root-only** — packages carry no `lint`/`format` scripts. The root pass (`oxfmt` + `oxlint $(git ls-files …)`) covers every workspace at once. `typescript` and `vitest` are declared once at the root and hoisted; packages don't redeclare them.

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
  storage-local/      # localStorage storage adapter (demos / lightweight apps)
  transport-graphql/  # GraphQL + WebSocket transport
  server/             # Server-side sync with Fastify + Drizzle
apps/
  docs/               # MDX docs content (docs.json); deployed via Blode.md — no package.json
  docs-worker/        # Cloudflare Worker routing stratasync.dev → docs + landing
  web/                # Next.js demo app
```

## Build Order

```
Layer 0: core, server (no internal deps)
Layer 1: y-doc, mobx (depend on core)
Layer 2: client (depends on core, y-doc)
Layer 3: react, storage-idb, storage-local, transport-graphql (depend on client + core)
Layer 4: next (depends on client, core, react)
```

## Gotchas

- **ESM only**: This project uses `"type": "module"`. Use `.js` extensions in imports (e.g., `import { foo } from "./foo.js"`).
- **Linting via oxlint/oxfmt**: Run `npm run lint:fix` to format and fix. Config presets come from `ultracite` (in `.oxlintrc.json` extends).
- **Git hooks via lefthook**: Pre-commit runs oxfmt + oxlint on staged files. Hooks install automatically via `npm install`.
- **Internal deps use `"*"`**: All `@stratasync/*` inter-package dependencies are pinned as `"*"` (npm workspaces resolves them locally). Don't switch to `workspace:*` — `changeset publish` shells out to `npm publish`, which does not rewrite the `workspace:` protocol, so it would publish broken manifests.
- **Coordinated versions**: All 10 published packages are a changesets `fixed` group — they always release together at the same version.
