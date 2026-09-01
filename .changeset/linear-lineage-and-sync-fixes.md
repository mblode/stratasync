---
"@stratasync/core": minor
"@stratasync/client": minor
"@stratasync/server": minor
"@stratasync/react": minor
"@stratasync/next": minor
"@stratasync/mobx": minor
"@stratasync/y-doc": minor
"@stratasync/storage-idb": minor
"@stratasync/storage-local": minor
"@stratasync/transport-graphql": minor
---

Correctness pass on the client sync path, plus package metadata that says what
these packages are.

Correctness fixes:

- **core**: a property serializer that returns `null` is no longer overridden by
  the raw value (`?? value` treated a legitimate `null` as "no serializer");
  leaving the NDJSON reader early — a timeout, a parse error, or a consumer
  breaking out of `for await` — now cancels the underlying stream instead of
  holding the HTTP body open behind a released reader; undoing an update sends
  an explicit `null` for fields that had no value before the change, because
  JSON drops an `undefined` member and the undo silently left the new value in
  place.
- **client**: a transaction the server does not report on is requeued rather
  than parked in `sent` until the next reconnect; `batchIndex` is seeded from
  the persisted outbox before the first transaction is stamped, so a fresh
  runtime cannot re-issue an index another tab already used; a cancelled
  partial bootstrap no longer records its sync groups as subscribed, which made
  the next start believe half-loaded groups were complete; a failed `start()`
  clears the running flag, so the next `start()` bootstraps instead of
  returning early; a scheduled resubscribe is cancelled on reset rather than
  firing into a later run and opening a second subscription; `stop()` and
  `clearAll()` share one teardown path and wait for an in-flight `start()` to
  observe the cancelled run before storage is closed or cleared; an update
  skips `undefined` members instead of diverging optimistic state from what the
  server was sent.
- **server**: a client whose cursor sits exactly one below the oldest retained
  sync action is no longer sent through a full bootstrap — the next action it
  needs is the earliest one kept.

Metadata:

- Every package now carries a `description`, `keywords`, `homepage`, `license`,
  `author`, `engines`, `sideEffects` and `publishConfig.provenance`, and ships
  `src` alongside `dist` so source maps resolve. `@stratasync/react` marks `yjs`
  as an optional peer dependency.
