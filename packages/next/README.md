# @stratasync/next

Next.js App Router integration helpers.

## Overview

`@stratasync/next` bridges the sync engine with Next.js App Router patterns:

- **Server utilities**: Bootstrap snapshot fetch/serialize/seed helpers
- **Client utilities**: The `NextSyncProvider` client component
- **Shared types**: Bootstrap and provider type exports

## Installation

```bash
npm install @stratasync/next
```

Peer dependencies: `next` ^14.0.0 || ^15.0.0 || ^16.0.0, `react` ^18.0.0 || ^19.0.0

## Exports

Use explicit subpaths for predictable behavior:

```typescript
// Client components
import {
  NextSyncProvider,
  type NextSyncProviderProps,
} from "@stratasync/next/client";

// Server components / route handlers
import {
  decodeBootstrapSnapshot,
  deserializeBootstrapSnapshot,
  encodeBootstrapSnapshot,
  isBootstrapSnapshotStale,
  prefetchBootstrap,
  seedStorageFromBootstrap,
  serializeBootstrapSnapshot,
  type BootstrapSnapshot,
  type BootstrapSnapshotPayload,
  type PrefetchBootstrapOptions,
  type SeedStorageOptions,
  type SeedStorageResult,
  type SerializeBootstrapOptions,
} from "@stratasync/next/server";

// Root import aliases the client entrypoint.
import { NextSyncProvider } from "@stratasync/next";
```

## Usage

Use Server Components for bootstrap loading and Client Components for interactive sync features:

```tsx
import {
  prefetchBootstrap,
  seedStorageFromBootstrap,
  type SeedStorageOptions,
} from "@stratasync/next/server";

declare const storage: SeedStorageOptions["storage"];

export default async function Page() {
  const snapshot = await prefetchBootstrap({ endpoint: "/sync" });
  await seedStorageFromBootstrap({ snapshot, storage });
  return <ClientApp>{/* render app */}</ClientApp>;
}
```

```tsx
"use client";

import { NextSyncProvider } from "@stratasync/next/client";
import type { SyncClient } from "@stratasync/client";
import type { ReactNode } from "react";

declare const client: SyncClient;

function ClientApp({ children }: { children: ReactNode }) {
  return <NextSyncProvider client={client}>{children}</NextSyncProvider>;
}
```
