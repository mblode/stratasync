# @stratasync/transport-graphql

GraphQL transport adapter for sync communication and mutations.

## Overview

sync-transport-graphql handles communication between the sync client and server:

- **GraphQL client initialization**: Sync endpoint configuration
- **Delta subscriptions**: GraphQL subscriptions over WebSocket
- **Mutation document generation**: Built from model metadata
- **Message serialization**: Sync payloads including Yjs binary deltas

## Installation

```bash
npm install @stratasync/transport-graphql
```

Dependencies: `@stratasync/core`, `@stratasync/y-doc`

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

1. **Bootstrap**: Fetches initial state via GraphQL query
2. **Subscribe**: Opens a WebSocket subscription for real-time deltas
3. **Mutate**: Sends client mutations as GraphQL mutations
4. **Reconnect**: Handles connection drops with automatic retry and resubscription

Yjs collaborative editing deltas are encoded as binary (Uint8Array) within GraphQL payloads.
