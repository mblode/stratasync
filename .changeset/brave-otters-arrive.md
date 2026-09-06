---
"stratasync": minor
---

Add the `stratasync` CLI. `npx stratasync init my-app` scaffolds a runnable app: a Fastify + Postgres sync server in `api/` and a React client in `web/`, as npm workspaces, with `@stratasync/*` pinned to the CLI's own version.

The template is built from the repo's `examples/` at build time rather than kept as a second copy, so it is the app the repo already tests. `init` supports `--dry-run`, `--force`, `--output json` and `--no-input`, writes data to stdout and hints to stderr, and refuses a non-empty directory unless forced.

This is a new package name, so the first publish is manual: npm cannot register a trusted publisher for a package that does not exist yet.
