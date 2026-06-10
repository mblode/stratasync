---
"@stratasync/core": patch
"@stratasync/client": patch
"@stratasync/server": patch
"@stratasync/react": patch
"@stratasync/mobx": patch
"@stratasync/next": patch
"@stratasync/y-doc": patch
"@stratasync/storage-idb": patch
"@stratasync/storage-local": patch
"@stratasync/transport-graphql": patch
---

Repo hygiene: standardized build/test/check-types scripts and tsconfigs across all packages, migrated the remaining `node:test` suites to Vitest, hoisted lint tooling to the root, and pinned all published packages into one coordinated release group. No runtime or API changes.
