---
"@stratasync/client": patch
"@stratasync/core": patch
---

Persist direct model assignments through the client outbox, retain newer
unsaved edits across overlapping saves, server reconciliation, and rejection,
emit generic mutation rejection events, and restore pending optimistic state
on warm startup.
