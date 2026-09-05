---
"@stratasync/server": patch
"@stratasync/client": patch
---

Prevent WebSocket cursors from advancing past missed durable group refreshes, force legacy clients to bootstrap when reconnect authorization rejects a stored group, and adopt authoritative group payloads before client replacement.
