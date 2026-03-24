# Client Setup Reference

All code templates for the Next.js client app. Replace `{{placeholders}}` with actual values.

---

## Dependencies

```bash
npm install @stratasync/core @stratasync/client @stratasync/react @stratasync/mobx \
  @stratasync/next @stratasync/storage-idb @stratasync/transport-graphql @stratasync/y-doc \
  mobx mobx-react-lite yjs
```

---

## tsconfig.json

Merge these into the existing `compilerOptions`. **`experimentalDecorators` is CRITICAL; decorators fail silently without it.**

```jsonc
{
  "compilerOptions": {
    "baseUrl": ".",
    "target": "ESNext",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "experimentalDecorators": true,
    "paths": {
      "@/*": ["./src/*"],
    },
    "plugins": [
      {
        "name": "next",
      },
    ],
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
  ],
  "exclude": ["node_modules"],
}
```

---

## next.config.ts

**`transpilePackages` is CRITICAL; ESM imports break without it.**

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  experimental: {
    externalDir: true,
  },
  reactStrictMode: true,
  transpilePackages: [
    "@stratasync/client",
    "@stratasync/core",
    "@stratasync/mobx",
    "@stratasync/next",
    "@stratasync/react",
    "@stratasync/storage-idb",
    "@stratasync/transport-graphql",
    "@stratasync/y-doc",
  ],
};

export default config;
```

---

## Model definition

`src/lib/sync/models/{{MODEL_NAME_LOWER}}.ts`

```ts
import { ClientModel, Model, Property } from "@stratasync/core";

@ClientModel("{{MODEL_NAME}}", { loadStrategy: "instant" })
export class {{MODEL_NAME}} extends Model {
  @Property() declare id: string;
  @Property() declare title: string;
  @Property() declare completed: boolean;
  @Property() declare createdAt: number;
  @Property() declare groupId: string;
}
```

Adapt fields to match the user's chosen model. `id` and `groupId` are always required.

---

## Models barrel

`src/lib/sync/models.ts`

**CRITICAL: Side-effect imports register decorators at module load. Without this, the schema is empty.**

```ts
import "./models/{{MODEL_NAME_LOWER}}";
```

---

## Config

`src/lib/sync/config.ts`

```ts
export const API_BASE_URL = "http://localhost:{{API_PORT}}";
export const DEV_GROUP_ID = "dev-group";
export const DEV_TOKEN = "dev-token";
export const DEV_USER_ID = "dev-user";
```

---

## Client factory

`src/lib/sync/create-client.ts`

```ts
// oxlint-disable no-use-before-define -- helper functions grouped after factory function
import type { SyncClient } from "@stratasync/client";
import { createSyncClient } from "@stratasync/client";
import { ModelRegistry } from "@stratasync/core";
import { createMobXReactivity } from "@stratasync/mobx";
import { createIndexedDbStorage } from "@stratasync/storage-idb";
import { GraphQLTransportAdapter } from "@stratasync/transport-graphql";

import { API_BASE_URL, DEV_GROUP_ID, DEV_TOKEN, DEV_USER_ID } from "./config";
import "./models";

const HTTP_PROTOCOL_RE = /^http/;
const SYNC_DB_PREFIX = "stratasync-{{PROJECT_NAME}}";
const SYNC_REQUEST_TIMEOUT_MS = 30_000;
const SYNC_USER_VERSION = 1;

let clientInstance: SyncClient | null = null;

const getDbName = (userId: string): string =>
  `${SYNC_DB_PREFIX}-v${SYNC_USER_VERSION}-${userId}`;

export const getSyncClient = (): SyncClient => {
  if (clientInstance) {
    return clientInstance;
  }

  const schema = ModelRegistry.snapshot();
  const wsUrl = API_BASE_URL.replace(HTTP_PROTOCOL_RE, "ws");
  const storage = createIndexedDbStorage();

  const transport = new GraphQLTransportAdapter({
    auth: {
      getAccessToken: () => Promise.resolve(DEV_TOKEN),
    },
    endpoint: `${API_BASE_URL}/sync`,
    syncEndpoint: `${API_BASE_URL}/sync`,
    timeout: SYNC_REQUEST_TIMEOUT_MS,
    wsEndpoint: `${wsUrl}/sync/ws`,
  });

  const rawClient = createSyncClient({
    batchDelay: 100,
    batchMutations: true,
    dbName: getDbName(DEV_USER_ID),
    groups: [DEV_GROUP_ID],
    optimistic: true,
    reactivity: createMobXReactivity(),
    schema,
    storage,
    transport,
    userId: DEV_USER_ID,
    userVersion: SYNC_USER_VERSION,
  });

  clientInstance = rawClient;
  return rawClient;
};
```

The client handles React StrictMode double-mount/unmount internally — `start()` awaits any pending `stop()` before proceeding.

---

## Providers

`src/app/providers.tsx`

```tsx
"use client";

import { NextSyncProvider } from "@stratasync/next/client";
import type { ReactNode } from "react";

import { getSyncClient } from "@/lib/sync/create-client";

export const Providers = ({ children }: { children: ReactNode }) => (
  <NextSyncProvider
    client={getSyncClient}
    loading={<div>Starting sync engine...</div>}
  >
    {children}
  </NextSyncProvider>
);
```

---

## Layout

`src/app/layout.tsx`

```tsx
import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  description: "{{PROJECT_NAME}} powered by Strata Sync.",
  title: "{{PROJECT_NAME}}",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

---

## Example page

`src/app/page.tsx`

```tsx
"use client";

import {
  useConnectionState,
  useIsOffline,
  useQuery,
  useSyncClientInstance,
} from "@stratasync/react";
import { observer } from "mobx-react-lite";
import type { FormEvent } from "react";
import { useCallback, useState } from "react";

import { DEV_GROUP_ID } from "@/lib/sync/config";
import type { {{MODEL_NAME}} } from "@/lib/sync/models/{{MODEL_NAME_LOWER}}";

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const {{MODEL_NAME}}Item = observer(
  ({
    item,
    onRemove,
    onToggle,
  }: {
    item: {{MODEL_NAME}};
    onRemove: (id: string) => void;
    onToggle: (item: {{MODEL_NAME}}) => void;
  }) => {
    const handleToggle = useCallback(() => {
      onToggle(item);
    }, [onToggle, item]);

    const handleRemove = useCallback(() => {
      onRemove(item.id);
    }, [onRemove, item.id]);

    return (
      <article data-completed={item.completed} key={item.id}>
        <input
          aria-label={`Toggle ${item.title}`}
          checked={item.completed}
          onChange={handleToggle}
          type="checkbox"
        />

        <div>
          <span>{item.title}</span>
          <span>
            Group <code>{item.groupId}</code>, created{" "}
            {formatTimestamp(item.createdAt)}
          </span>
        </div>

        <button onClick={handleRemove} type="button">
          Delete
        </button>
      </article>
    );
  }
);

const ExamplePage = observer(function ExamplePage() {
  const client = useSyncClientInstance();
  const { backlog, error, lastSyncId, status } = useConnectionState();
  const isOffline = useIsOffline();
  const { data: items, isLoading } = useQuery<{{MODEL_NAME}}>("{{MODEL_NAME}}", {
    orderBy: (a, b) => b.createdAt - a.createdAt,
  });

  const [draft, setDraft] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);

  const completedCount = items.filter((item) => item.completed).length;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const title = draft.trim();

      if (!title) {
        return;
      }

      setMutationError(null);

      try {
        await client.create("{{MODEL_NAME}}", {
          completed: false,
          createdAt: Date.now(),
          groupId: DEV_GROUP_ID,
          title,
        });
        setDraft("");
      } catch (caughtError) {
        setMutationError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to create item."
        );
      }
    },
    [client, draft]
  );

  const handleToggle = useCallback(
    async (item: {{MODEL_NAME}}) => {
      setMutationError(null);

      try {
        await client.update("{{MODEL_NAME}}", item.id, {
          completed: !item.completed,
        });
      } catch (caughtError) {
        setMutationError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to update item."
        );
      }
    },
    [client]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setMutationError(null);

      try {
        await client.delete("{{MODEL_NAME}}", id);
      } catch (caughtError) {
        setMutationError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to delete item."
        );
      }
    },
    [client]
  );

  const handleDraftChange = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      setDraft(event.currentTarget.value);
    },
    []
  );

  return (
    <main>
      <h1>{{PROJECT_NAME}}</h1>
      <p>
        Offline-first sync powered by Strata Sync. Open in two tabs to see
        real-time sync.
      </p>

      <div>
        <span>Total: {items.length}</span>
        <span>Completed: {completedCount}</span>
        <span>Backlog: {backlog}</span>
        <span>
          Sync: {isOffline ? "offline" : status} (last: {String(lastSyncId)})
        </span>
        {error ? <span>Error: {error.message}</span> : null}
      </div>

      {mutationError ? <div role="alert">{mutationError}</div> : null}

      <form onSubmit={handleSubmit}>
        <input
          onChange={handleDraftChange}
          placeholder="Add a {{MODEL_NAME_LOWER}}..."
          value={draft}
        />
        <button type="submit">Create</button>
      </form>

      <div>
        {isLoading && items.length === 0 ? (
          <p>Bootstrapping local state...</p>
        ) : null}

        {!isLoading && items.length === 0 ? (
          <p>Nothing synced yet. Create a {{MODEL_NAME_LOWER}} to get started.</p>
        ) : null}

        {items.map((item) => (
          <{{MODEL_NAME}}Item
            item={item}
            key={item.id}
            onRemove={handleRemove}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </main>
  );
});

export default ExamplePage;
```
