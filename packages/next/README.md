# @stratasync/next

Next.js App Router integration helpers.

## Overview

sync-next bridges the sync engine with Next.js App Router patterns:

- **Server utilities** — server-side setup and initialization
- **Client utilities** — hooks and providers for client components
- **Metadata helpers** — integration with Next.js metadata API

## Installation

```bash
npm install @stratasync/next
```

Peer dependencies: `next` ^14.0.0 || ^15.0.0, `react` ^18.0.0 || ^19.0.0

## Exports

The package has separate entry points for server and client code:

```typescript
// Client components
import {} from /* client utilities */ "@stratasync/next/client";

// Server components / route handlers
import {} from /* server utilities */ "@stratasync/next/server";

// Default export (client-side)
import {} from /* default exports */ "@stratasync/next";
```

## Usage

Use Server Components for initial data loading and Client Components for interactive sync features:

```tsx
// Server Component — fetch initial data
import { initSync } from "@stratasync/next/server";

export default async function Page() {
  const initialData = await initSync();
  return <ClientApp initialData={initialData} />;
}

// Client Component — use sync hooks
("use client");
import { useSyncClient } from "@stratasync/next/client";

function ClientApp({ initialData }) {
  const client = useSyncClient({ initialData });
  // ...
}
```
