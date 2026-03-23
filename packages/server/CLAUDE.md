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
- Auth is pluggable via `SyncAuthConfig`. The package does NOT know about Supabase, API keys, or any specific auth provider.
- Logger is injected via `SyncLogger` interface. There is no pino dependency; a noop logger is used when none is provided.
- Redis is optional. The package falls back to in-memory delta bus for single-server / dev mode.
- Fastify routes and WebSocket are in the `./fastify` export. Import from `@stratasync/server/fastify`.

## Conventions

- Services are stateless and receive dependencies via constructor (db, dao, logger, config).
- Route handlers are thin: parse request, call service, return response.
- Model definitions use `StandardMutateConfig` (has ID, supports I/U/D/A/V) or `CompositeMutateConfig` (composite key, I/D only).
- App-specific mutation logic (e.g., task repeat handling) is wired via `onBeforeInsert`/`onBeforeUpdate`/`onAfterMutation` hooks in model config.
- WebSocket live editing is injected via `WebSocketHooks`. sync-server knows nothing about Yjs.
