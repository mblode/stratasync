# @stratasync/storage-idb

IndexedDB storage adapter for client-side persistence in the Done.

## Overview

sync-storage-idb provides offline-capable persistence using IndexedDB:

- **IndexedDB abstraction** via the `idb` library
- **Schema migrations** with versioned database upgrades
- **Transactional writes** for data consistency
- **Offline data persistence** for local-first architecture

## Installation

```bash
npm install @stratasync/storage-idb
```

Dependency: `idb` ^8.0.0

## Usage

```typescript
import { createIdbStorage } from "@stratasync/storage-idb";

const storage = createIdbStorage({
  dbName: "lse-sync",
  version: 1,
});

// Pass to SyncClient configuration
const client = new SyncClient({
  storage,
});
```

The storage adapter handles:

- Persisting model instances to IndexedDB
- Loading cached data on startup for instant UI
- Managing schema migrations when the database version changes
- Transactional writes to prevent partial updates

## Testing

Tests use `fake-indexeddb` to mock the IndexedDB API in Node.js:

```bash
npm run test
# Runs: node --import tsx --test "tests/**/*.test.ts"
```
