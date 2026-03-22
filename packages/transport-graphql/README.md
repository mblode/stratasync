# @stratasync/transport-graphql

GraphQL transport adapter for sync communication and mutations in the Done.

## Overview

sync-transport-graphql handles communication between the sync client and server:

- **GraphQL client initialization** for sync endpoints
- **Delta subscriptions** via GraphQL subscriptions over WebSocket
- **Mutation document generation** from model metadata
- **Message serialization** for sync payloads including Yjs binary deltas

## Installation

```bash
npm install @stratasync/transport-graphql
```

Dependencies: `@stratasync/core`, `@stratasync/yjs`

## Usage

```typescript
import { createGraphQLTransport } from "@stratasync/transport-graphql";

const transport = createGraphQLTransport({
  endpoint: "https://api.example.com/graphql",
  wsEndpoint: "wss://api.example.com/graphql",
});

// Pass to SyncClient configuration
const client = new SyncClient({
  transport,
});
```

## How It Works

1. **Bootstrap** — fetches initial state via GraphQL query
2. **Subscribe** — opens a WebSocket subscription for real-time deltas
3. **Mutate** — sends client mutations as GraphQL mutations
4. **Reconnect** — handles connection drops with automatic retry and resubscription

Yjs collaborative editing deltas are encoded as binary (Uint8Array) within GraphQL payloads.
