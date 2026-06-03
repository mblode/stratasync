# @stratasync/y-doc

## 0.2.5

### Patch Changes

- b4f4433: Fix description seeding: seed from canonical content when the Yjs prosemirror fragment has no derived text, not only when it is completely empty. A stray empty paragraph (written by the editor on mount before half-synced text-bearing updates arrive) no longer blocks canonical seeding, so a freshly-opened client renders the description instead of a blank editor.

## 0.2.4

### Patch Changes

- a18b3c8: Fix sync cursor advancement, own-echo rebase handling, Yjs initial content and presence cleanup, React stale query/client state, authenticated bootstrap retry, delta pagination guards, and IndexedDB empty batch handling.

## 0.2.3

### Patch Changes

- 3f7626e: Bug fixes and improvements across all packages

## 0.2.2

### Patch Changes

- 7e2a573: stratasync

## 0.2.1

### Patch Changes

- Initial patch release
