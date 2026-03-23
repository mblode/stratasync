# @stratasync/mobx

MobX reactivity adapter for the sync engine.

## Overview

sync-mobx implements the reactivity adapter interface defined in `@stratasync/core` using MobX observables:

- **Observable model instances**: Model properties become MobX observables
- **Computed values**: Derived state from observable model properties
- **Reaction-based updates**: Automatic re-rendering when synced data changes

## Installation

```bash
npm install @stratasync/mobx mobx
```

Peer dependency: `mobx` ^6.0.0

## Usage

Register the MobX adapter when initializing the sync client:

```typescript
import { createSyncClient } from "@stratasync/client";
import { createMobXReactivity } from "@stratasync/mobx";

const client = createSyncClient({
  reactivity: createMobXReactivity(),
  // ...storage, transport
});
```

The adapter makes model instances observable, so MobX `observer()` components and `autorun` / `reaction` will automatically track and respond to sync updates.

## How It Works

1. When models are hydrated from sync deltas, the adapter wraps properties with MobX observables
2. React components wrapped with `observer()` automatically re-render when observed properties change
3. Computed values can derive state from multiple observable model properties
