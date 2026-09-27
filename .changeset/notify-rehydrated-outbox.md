---
"@stratasync/client": patch
---

Emit `modelChange` for each pending outbox transaction that `start()` replays into the identity maps. The replay runs after the client reports "syncing", so a query that read on that transition missed rows created offline until something else changed, and a task created offline vanished on an offline reload.
