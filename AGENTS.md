# stratasync

Local-first, server-sequenced sync engine for TypeScript, React, and Next.js

## Commands

```bash
npm install              # setup (requires Node >= 22); also installs lefthook hooks
npm run build            # turbo run build
npm run dev              # turbo run dev
npm run test             # turbo run test
npm run typecheck        # turbo run check-types
npm run lint:fix         # oxfmt + oxlint autofix (repo-wide)
npm run lint             # oxfmt check + oxlint (CI; repo-wide)
npx turbo run test --filter=@stratasync/client        # one package, deps built first
cd packages/core && npx vitest run tests/<file> --reporter=dot   # one file, quiet
```

Lint and format are **root-only**: packages carry no `lint`/`format` scripts, whatever a package's own `AGENTS.md` says. The root pass (`oxfmt` + `oxlint $(git ls-files …)`) covers every workspace at once. `typescript` and `vitest` are declared once at the root and hoisted; packages don't redeclare them.

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
  conformance/        # Language-agnostic conformance corpus every implementation must pass
  cli/                # `stratasync` npm CLI: `npx stratasync init my-app` scaffolder
  stratasync-swift/    # Apple SDK; root Package.swift is the SwiftPM entry
  stratasync-kotlin/   # JVM SDK foundation; Gradle wrapper, JDK 21
apps/
  docs/               # MDX docs content (docs.json); deployed via Blode.md, no package.json
  docs-worker/        # Cloudflare Worker routing stratasync.dev → docs + landing
  web/                # Next.js demo app
examples/
  api/                # Runnable Fastify + Postgres sync server
  web/                # Runnable client against it
skills/
  scaffold-stratasync/  # Agent skill: create a new app
  stratasync/           # Agent skill: work in an app that already syncs
verification/lean/    # Lean 4 models of the sync algorithms (see its README)
```

`skills/<name>/SKILL.md` at the repo root is the layout `npx skills add
mblode/stratasync` discovers, which is the command the README and the landing
page advertise. Keep skills there rather than under `.claude/`, and keep the
frontmatter to `name` and `description` only; other keys are ignored by the
spec, and trigger phrases belong inside the description.

## Build Order

Packages import each other from `dist/` (`exports` point there), and turbo's `^build` builds dependencies before `build`, `test`, and `check-types`. Running `vitest` directly inside a package tests against the last-built `dist/` of its dependencies, so after editing `core` or `client`, go through `npx turbo run test --filter=<dependent>` or rebuild first.

## Gotchas

- **ESM only**: This project uses `"type": "module"`. Use `.js` extensions in imports (e.g., `import { foo } from "./foo.js"`).
- **Linting via oxlint/oxfmt**: Run `npm run lint:fix` to format and fix. Config presets come from `ultracite` (in `.oxlintrc.json` extends).
- **Git hooks via lefthook**: Pre-commit runs oxfmt + oxlint on staged files, plus the native corpus check and Swift/Kotlin suites when their paths are staged. Hooks install automatically via `npm install`.
- **Changesets gate PRs**: CI runs `npx changeset status --since origin/main`, which fails when a published package changed without a changeset. Add one with `npx changeset` (or `npx changeset add --empty` when the change under `packages/` does not ship).
- **Internal deps use `"*"`**: All `@stratasync/*` inter-package dependencies are pinned as `"*"` (npm workspaces resolves them locally). Don't switch to `workspace:*`: `changeset publish` shells out to `npm publish`, which does not rewrite the `workspace:` protocol, so it would publish broken manifests.
- **Coordinated versions**: All published packages are a changesets `fixed` group; they always release together at the same version.
- **Conformance corpus**: `packages/conformance/corpus/` is the cross-language contract (vectors, scenarios, capability manifests). It is data, not code, and the Swift SDK here bundles a byte-checked copy and Kotlin reads them directly. Editing a vector or scenario to make one language pass silently breaks the others; **fix the implementation, not the corpus**. After any corpus edit run `npm run lint:fix` **first** and `npm run corpus:manifest --workspace=packages/conformance` second: oxfmt formats the corpus JSON too, so regenerating before formatting leaves a stale manifest and a red suite. Read `packages/conformance/corpus/README.md` before adding to it.
- **Generated route tree churn**: `npm run build` rewrites `examples/web/src/routeTree.gen.ts` in a different order. Unless you changed `examples/web/src/routes/`, restore it with `git checkout -- examples/web/src/routeTree.gen.ts` before committing.
- **Postgres suite is opt-in**: `npm run test` skips the server's Postgres tests. Run them with `STRATASYNC_TEST_DATABASE_URL=<isolated local db> npm run test:postgres --workspace=packages/server`.

## Native SDK checks

- `npm run test:swift`: canonical corpus integrity and Swift package suite (macOS).
- `npm run test:kotlin`: canonical corpus integrity and JVM conformance/recovery tests (JDK 21).
- `npm run test:swift:consumer`: isolated Git SwiftPM consumer.
- Native CI and lefthook invoke the same commands. Kotlin fixture publication and consumer resolution also run in CI.
- Done Bear consumes this repository directly through SwiftPM at an immutable revision. Edit SDK source here; upgrading the consumer requires updating its Xcode project and Package.resolved, then running iOS tests/build.
- Shared scenario coverage is Swift 11/11 and Kotlin 11/11. Both also run seven client wire-vector groups. Passing this corpus does not imply feature parity beyond its cases.

## Verification

Prove a change with what CI runs (`.github/workflows/ci.yml`, `native.yml`), in this order:

```bash
npm run lint && npm run typecheck && npm run test && npm run build
node scripts/check-driver-verdict.mjs -- node packages/client/dist/conformance/driver.js run   # TS conformance driver, needs build
npm run test:swift        # when Swift, Package.swift, or the corpus changed
npm run test:kotlin       # when Kotlin or the corpus changed; needs JDK 21
```

Behaviour is pinned by the conformance corpus and, for algorithm changes, the Lean models (`cd verification/lean && lake build`; needs elan, not in CI).

There is no `npm run doctor`, `npm run verify`, or feature map. Gap: no single command runs the chain above, and nothing checks the toolchain (Node 22+, Swift, JDK 21, a Postgres URL) before work starts, so a missing JDK surfaces only when lefthook or CI runs the Kotlin suite.
