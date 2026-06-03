---
"@stratasync/y-doc": patch
---

Fix description seeding: seed from canonical content when the Yjs prosemirror fragment has no derived text, not only when it is completely empty. A stray empty paragraph (written by the editor on mount before half-synced text-bearing updates arrive) no longer blocks canonical seeding, so a freshly-opened client renders the description instead of a blank editor.
