# @stratasync/server

Generic server-side sync SDK for the stratasync protocol. Provides bootstrap streaming, delta publishing, mutation processing, and WebSocket real-time sync with a registration-based model API.

## Commands

- `npm run build`: compile TypeScript (`tsc`)
- `npm run dev`: watch mode (`tsc --watch`)
- `npm run test`: run tests (Vitest)
- `npm run lint`: lint with Oxlint
- `npm run check-types`: type check without emitting

## Gotchas

- This package does NOT hardcode any models. Consumers register models via `createSyncServer({ models: { ... } })`.
- The DAO accepts Drizzle table references (not hardcoded schema imports). Tables must have the expected column names (`id`, `model`, `modelId`, `action`, `data`, `groupId`, `clientId`, `clientTxId`, `createdAt` for syncActions; `id`, `userId`, `groupId`, `groupType`, `createdAt` for syncGroupMemberships).
- Date handling: `dateOnly` fields use day-aligned UTC epochs (multiples of 86400000ms), `instant` fields use millisecond epochs. Mixing them corrupts sync data.
- Field codecs: update payloads are filtered through `updateFields` in model config. Fields not in the set are silently dropped.
- Group resolution: every model compiles to exactly one authorization resolver. `groupKey` is sugar built into `resolveGroup` at registry time. `resolveGroup` sees pre-mutation state and is the write-access boundary. Optional `resolvePublishGroup` runs after the model mutation inside the same transaction; standard writes receive the complete reloaded post-state row, deletes receive the pre-state row, and composite models receive handler data. It only selects the sync action's delivery group and never grants or validates access. Use a transactional before-hook to validate destination access for audience-changing writes. A publish resolver failure rolls back the row and action.
- `insertCreatesGroup` is the only way a write may target a group the caller does not yet hold, and only for `action === "I"` — the membership row is written inside the same transaction, so a failed insert rolls it back. It requires an explicit `groupType` (the registry throws at startup otherwise; that value lands in a table the consumer owns and is not ours to guess). Set it only on models whose resolved group is the row's own id; on a model resolving to another row's group it would grant membership to any inserter.
- A group grant is scoped to the mutate batch, not written back into the caller's `SyncUserContext`. Later transactions in the same batch see it; the next request sees it because `authorizeToken` re-reads the membership row.
- `notifyGroupsChanged(userId)` writes a `"G"` sync action addressed to that user's own group carrying their full current group list, then publishes it. It is an action rather than a frame so it is durable: a user who is offline still receives it on their next replay or catch-up. Redis publication failure rejects after the action commits so a durable app queue can retry. WebSocket sessions immediately intersect their existing groups with this list, preventing later delivery from revoked groups without allowing additions before reauthorization. It does not write or revoke the membership itself — call it after you do.
- For security-sensitive membership authorities, combine `groupResolutionMode: "authoritative"` with `reauthorizeBeforeWebSocketDelivery: true`. The former excludes stored membership mirrors; the latter serializes a complete fresh read authorization before every group-scoped WS action and subscribed frame, only narrowing the live session. `webSocketGroupRefreshCatchUpIntervalMs` repairs missed `"G"` transport delivery with a separate durable cursor, guards every ordinary cursor advance against a missed refresh, and forces bootstrap for retention gaps or rejected requested groups; the per-frame gate is the confidentiality boundary.
- Auth is pluggable via `SyncAuthConfig`. The package does NOT know about Supabase, API keys, or any specific auth provider.
- Logger is injected via `SyncLogger` interface. There is no pino dependency; a noop logger is used when none is provided.
- Live WebSocket deltas are notifications, not the source of truth: a delta above `scannedThrough + 1` first has the skipped ids read from `sync_actions` (`getSyncActionsThrough`), so a publish from another process that overtakes a lower id cannot push the cursor past it. This is sound only because `createSyncAction` allocates ids under the transaction-scoped advisory lock (and the id sequence keeps the default `CACHE 1`): once an id is committed, every lower id that will ever commit is visible. Every insert into `sync_actions` must go through `createSyncAction` inside a transaction.
- `getEarliestSyncId` on an empty `sync_actions` returns one above the id sequence's high-water mark (`pg_sequence_last_value(pg_get_serial_sequence(...))`), so a cursor whose actions were all pruned is still reported stale. The `id` column must be sequence-backed (serial/identity) for that.
- Composite bootstrap cursors (`cursor.type === "composite"`) may use nullable columns: ordering is `ASC NULLS LAST` and the keyset condition is NULL-safe. The field tuple must still be unique (treating NULLs as equal) — end the list with the primary key.
- Redis is optional. The package falls back to in-memory delta bus for single-server / dev mode.
- Fastify routes and WebSocket are in the `./fastify` export. Import from `@stratasync/server/fastify`.

## Conventions

- Services are stateless and receive dependencies via constructor (db, dao, logger, config).
- Route handlers are thin: parse request, call service, return response.
- Model definitions use `StandardMutateConfig` (has ID, supports I/U/D/A/V) or `CompositeMutateConfig` (composite key, I/D only).
- App-specific mutation logic (e.g., task repeat handling) is wired via `onBeforeInsert`/`onBeforeUpdate`/`onBeforeDelete`/`onAfterMutation` hooks in model config. Composite insert/delete before-hooks run inside the row transaction after group access succeeds.
- WebSocket live editing is injected via `WebSocketHooks`. sync-server knows nothing about Yjs.
