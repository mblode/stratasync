# @stratasync/yjs

Yjs CRDT utilities and integration for collaborative editing in the Done.

## Overview

sync-yjs provides Yjs document management and protocol utilities:

- **Document management** — create and manage Yjs documents for collaborative fields
- **Awareness protocol** — presence and cursor tracking across clients
- **Delta serialization** — encode/decode Yjs updates for transport
- **Sync protocol** — state vector exchange and update application

## Installation

```bash
npm install @stratasync/yjs
```

Dependency: `yjs` ^13.6.21

## Usage

```typescript
import { createYjsManager } from "@stratasync/yjs";

const yjsManager = createYjsManager();

// Create a document for a collaborative field
const doc = yjsManager.getOrCreateDoc("Task", taskId, "description");

// Encode state for transport
const update = Y.encodeStateAsUpdate(doc);

// Apply remote update
Y.applyUpdate(doc, remoteUpdate);
```

## Concepts

- **One Yjs document per collaborative field** — e.g., `Task.description` gets its own doc
- **Awareness** — separate protocol for presence (cursors, selections, user info)
- **Binary encoding** — Yjs uses efficient binary encoding, not JSON
- **Conflict-free** — CRDT guarantees eventual consistency without server coordination
