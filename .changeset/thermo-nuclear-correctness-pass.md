---
"@stratasync/transport-graphql": minor
"@stratasync/storage-local": minor
"@stratasync/storage-idb": minor
"@stratasync/server": minor
"@stratasync/client": minor
"@stratasync/core": minor
"@stratasync/react": minor
"@stratasync/mobx": minor
"@stratasync/next": minor
"@stratasync/y-doc": minor
---

Repo-wide correctness and simplification pass.

Correctness fixes:

- **core**: parse an `end` bootstrap line carrying `lastSyncId` as an end line
  (was misread as metadata); flush the NDJSON decoder at EOF so a trailing
  multi-byte character is not dropped; retry a rejected cached reference instead
  of replaying the rejection.
- **server**: allocate sync-action ids in commit order via a per-table advisory
  lock, closing a gap where a late-committing lower id could be permanently
  dropped for live subscribers; **security** — reject group-keyed
  UPDATE/DELETE/ARCHIVE/UNARCHIVE whose group column is null (previously skipped
  authorization and broadcast the write to every tenant).
- **client**: apply optimistic unarchive without destroying the class instance;
  complete transactions immediately when the mutate result carries no sync id
  (previously parked forever); emit a `modelChange` when the identity map evicts
  an entry so hooks re-render and Suspense re-hydrates.
- **storage-local**: a single corrupted stored value no longer permanently
  bricks the adapter; writes surface quota errors as a typed `StorageQuotaError`.
- **transport-graphql**: fail active subscriptions when reconnect retries are
  exhausted (iterators previously hung forever).
- **react**: provider render is now side-effect free; `useQuery` resets its
  state when the model name changes.
- **next**: bootstrap prefetch no longer produces an unhandled rejection when
  the stream rejects after the timeout wins.

Behavioral / API changes:

- `SyncDb` now requires an `execute()` method.
- `SyncDao.getLastSyncId` removed (unused).
- `CachedPromise` gains an optional `referenceId`; assigning a pending or empty
  cached reference now writes/clears the foreign key (previously a silent no-op).
- `IdentityMap`/`IdentityMapRegistry` gain an optional `onEvict` callback.
- Bootstrap `returnedModelsCount` now reflects rows in scope at the snapshot
  (informational; pre touched-filter).

Also: y-doc clamps retry delay after jitter and extracts ProseMirror content
helpers; mobx and server shed unreachable code paths.
