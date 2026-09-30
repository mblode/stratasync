# stratasync

Local-first, server-sequenced sync engine for TypeScript, React, and Next.js

## Commands

```bash
pnpm install              # setup (requires Node >= 22); also installs lefthook hooks
pnpm run build            # turbo run build
pnpm run dev              # turbo run dev
pnpm run test             # turbo run test
pnpm run typecheck        # turbo run check-types
pnpm run lint:fix         # oxfmt + oxlint autofix (repo-wide)
pnpm run lint             # oxfmt check + oxlint (CI; repo-wide)
pnpm exec turbo run test --filter=@stratasync/client        # one package, deps built first
cd packages/core && pnpm exec vitest run tests/<file> --reporter=dot   # one file, quiet
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

Packages import each other from `dist/` (`exports` point there), and turbo's `^build` builds dependencies before `build`, `test`, and `check-types`. Running `vitest` directly inside a package tests against the last-built `dist/` of its dependencies, so after editing `core` or `client`, go through `pnpm exec turbo run test --filter=<dependent>` or rebuild first.

## Gotchas

- **ESM only**: This project uses `"type": "module"`. Use `.js` extensions in imports (e.g., `import { foo } from "./foo.js"`).
- **Linting via oxlint/oxfmt**: Run `pnpm run lint:fix` to format and fix. Config presets come from `ultracite` (in `.oxlintrc.json` extends).
- **Git hooks via lefthook**: Pre-commit runs oxfmt + oxlint on staged files, plus the native corpus check and Swift/Kotlin suites when their paths are staged. Hooks install automatically via `pnpm install`.
- **Changesets gate PRs**: CI runs `pnpm exec changeset status --since origin/main`, which fails when a published package changed without a changeset. Add one with `pnpm exec changeset` (or `pnpm exec changeset add --empty` when the change under `packages/` does not ship).
- **Internal deps use `"*"`**: All `@stratasync/*` inter-package dependencies are pinned as `"*"` (pnpm resolves them locally via `linkWorkspacePackages`). Don't switch to `workspace:*`: the `"*"` pin keeps the published manifests and the SwiftPM/Kotlin consumers independent of the package manager.
- **Coordinated versions**: All published packages are a changesets `fixed` group; they always release together at the same version.
- **Conformance corpus**: `packages/conformance/corpus/` is the cross-language contract (vectors, scenarios, capability manifests). It is data, not code, and the Swift SDK here bundles a byte-checked copy and Kotlin reads them directly. Editing a vector or scenario to make one language pass silently breaks the others; **fix the implementation, not the corpus**. After any corpus edit run `pnpm run lint:fix` **first** and `pnpm --filter @stratasync/conformance run corpus:manifest` second: oxfmt formats the corpus JSON too, so regenerating before formatting leaves a stale manifest and a red suite. Read `packages/conformance/corpus/README.md` before adding to it.
- **Generated route tree churn**: `pnpm run build` rewrites `examples/web/src/routeTree.gen.ts` in a different order. Unless you changed `examples/web/src/routes/`, restore it with `git checkout -- examples/web/src/routeTree.gen.ts` before committing.
- **Postgres suite is opt-in**: `pnpm run test` skips the server's Postgres tests. Run them with `STRATASYNC_TEST_DATABASE_URL=<isolated local db> pnpm --filter @stratasync/server run test:postgres`.

## Native SDK checks

- `pnpm run test:swift`: canonical corpus integrity and Swift package suite (macOS).
- `pnpm run test:kotlin`: canonical corpus integrity and JVM conformance/recovery tests (JDK 21).
- `pnpm run test:swift:consumer`: isolated Git SwiftPM consumer.
- Native CI and lefthook invoke the same commands. Kotlin fixture publication and consumer resolution also run in CI.
- Done Bear consumes this repository directly through SwiftPM at an immutable revision. Edit SDK source here; upgrading the consumer requires updating its Xcode project and Package.resolved, then running iOS tests/build.
- Shared scenario coverage is Swift 11/11 and Kotlin 11/11. Both also run seven client wire-vector groups. Passing this corpus does not imply feature parity beyond its cases.

## Verification

Prove a change with what CI runs (`.github/workflows/ci.yml`, `native.yml`), in this order:

```bash
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build
node scripts/check-driver-verdict.mjs -- node packages/client/dist/conformance/driver.js run   # TS conformance driver, needs build
pnpm run test:swift        # when Swift, Package.swift, or the corpus changed
pnpm run test:kotlin       # when Kotlin or the corpus changed; needs JDK 21
```

Behaviour is pinned by the conformance corpus and, for algorithm changes, the Lean models (`cd verification/lean && lake build`; needs elan, not in CI).

There is no `pnpm run doctor`, `pnpm run verify`, or feature map. Gap: no single command runs the chain above, and nothing checks the toolchain (Node 22+, Swift, JDK 21, a Postgres URL) before work starts, so a missing JDK surfaces only when lefthook or CI runs the Kotlin suite.
