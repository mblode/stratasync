# @stratasync/mobx

MobX reactivity adapter for the sync engine.

## Overview

sync-mobx implements the reactivity adapter interface defined in `@stratasync/core` using MobX observables:

- **Observable model instances**: Model properties become MobX observables
- **Computed values**: Derived state from observable model properties
- **Reaction-based updates**: Automatic re-rendering when synced data changes

## Installation

```bash
npm install @stratasync/mobx
```

Peer dependency: `mobx` ^6.0.0

## Usage

Register the MobX adapter when initializing the sync client:

```typescript
import { createMobxAdapter } from "@stratasync/mobx";

const adapter = createMobxAdapter();

// Pass to SyncClient configuration
const client = new SyncClient({
  reactivityAdapter: adapter,
});
```

The adapter makes model instances observable, so MobX `observer()` components and `autorun` / `reaction` will automatically track and respond to sync updates.

## How It Works

1. When models are hydrated from sync deltas, the adapter wraps properties with MobX observables
2. React components wrapped with `observer()` automatically re-render when observed properties change
3. Computed values can derive state from multiple observable model properties
