# @stratasync/y-doc

Yjs CRDT utilities and integration for collaborative editing.

## Overview

`@stratasync/y-doc` provides Yjs document management and protocol utilities:

- **Document management**: Create and manage Yjs documents for collaborative fields
- **Awareness protocol**: Presence and cursor tracking across clients
- **Delta serialization**: Encode/decode Yjs updates for transport
- **Sync protocol**: State vector exchange and update application

## Installation

```bash
npm install @stratasync/y-doc yjs
```

`yjs` is a peer dependency, so install it alongside `@stratasync/y-doc`.

## Usage

```typescript
import { YjsDocumentManager } from "@stratasync/y-doc";
import type { DocumentKey } from "@stratasync/y-doc";
import * as Y from "yjs";

const documentManager = new YjsDocumentManager({
  clientId: "client-123",
  connId: "conn-456",
});

const taskId = "task-123";

const docKey: DocumentKey = {
  entityType: "Task",
  entityId: taskId,
  fieldName: "description",
};

const doc = documentManager.getDocument(docKey);
const fragment = doc.getXmlFragment("prosemirror");

const paragraph = new Y.XmlElement("paragraph");
const text = new Y.XmlText();
text.insert(0, "Hello");
paragraph.insert(0, [text]);
fragment.insert(0, [paragraph]);

// Encode state for transport
const update = Y.encodeStateAsUpdate(doc);

// In practice, this buffer comes from the server.
Y.applyUpdate(doc, update);
```

## Concepts

- **One Yjs document per collaborative field** (e.g., `Task.description` gets its own doc)
- **ProseMirror fragment**: `YjsDocumentManager` reads and seeds the `prosemirror` fragment
- **Awareness**: Separate protocol for presence (cursors, selections, user info)
- **Binary encoding**: Yjs uses efficient binary encoding, not JSON
- **Conflict-free**: CRDT guarantees eventual consistency without server coordination
