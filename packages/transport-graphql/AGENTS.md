# @stratasync/transport-graphql

GraphQL transport adapter for sync communication and mutations.

## Commands

- `npm run build` — compile TypeScript (`tsc`)
- `npm run dev` — watch mode (`tsc --watch`)
- `npm run test` — run tests (`vitest`)
- `npm run lint` — lint with Oxlint
- `npm run check-types` — type check without emitting

## Gotchas

- Depends on both `@stratasync/core` and `@stratasync/y-doc` — both must be built first
- Delta subscriptions use GraphQL subscriptions over WebSocket — connection state must be managed
- Yjs deltas are serialized as binary (Uint8Array) within GraphQL payloads — encoding/decoding must be handled correctly
- Mutation documents are generated from model metadata — schema changes in sync-core affect transport payloads

## Conventions

- Transport is a thin adapter — business logic belongs in sync-client, not here
- Subscription reconnection and retry logic lives in this package
- Serialize/deserialize sync messages using the shared types from sync-core
